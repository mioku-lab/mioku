import type { AIInstance } from "mioku";
import { logger } from "mioku";
import { extractJsonObject } from "../utils/json";
import { readField } from "../utils/record";
import type { ChatDatabase } from "../db";
import type { ChatMessage } from "../types";
import { extractGroupIdFromSession } from "../utils/group-config";
import type { ChatConfigProvider } from "./index";

export class TopicTracker {
  private ai: AIInstance;
  private getConfig: ChatConfigProvider;
  private db: ChatDatabase;
  private lastAnalyzedWindowEnd: Map<string, number> = new Map();

  constructor(ai: AIInstance, configProvider: ChatConfigProvider, db: ChatDatabase) {
    this.ai = ai;
    this.getConfig = configProvider;
    this.db = db;
  }

  async onMessage(sessionId: string): Promise<void> {
    const cfg = this.getConfig(extractGroupIdFromSession(sessionId));
    if (!cfg.topic?.enabled) return;
    if (!sessionId.startsWith("group:")) return;

    const windowMs = this.getWindowMs(cfg);
    const completedWindowEnd = Math.floor(Date.now() / windowMs) * windowMs;
    if (completedWindowEnd <= 0) return;

    const lastAnalyzedEnd = this.lastAnalyzedWindowEnd.get(sessionId) ?? 0;
    if (completedWindowEnd <= lastAnalyzedEnd) {
      return;
    }

    this.lastAnalyzedWindowEnd.set(sessionId, completedWindowEnd);
    const windowStartAt = completedWindowEnd - windowMs;

    this.analyzeWindow(sessionId, windowStartAt, completedWindowEnd, cfg).catch(
      (err) => logger.warn(`[TopicTracker] Analysis failed: ${err}`),
    );
  }

  getTopicContext(sessionId: string, historyStartAt?: number): string {
    const cfg = this.getConfig(extractGroupIdFromSession(sessionId));
    if (!cfg.topic?.enabled) return "";
    if (!sessionId.startsWith("group:")) return "";
    if (!historyStartAt) return "";

    const windowMs = this.getWindowMs(cfg);
    const windowCount = this.getHistoryWindowCount(cfg);
    const firstWindowEnd = Math.floor(historyStartAt / windowMs) * windowMs;
    if (firstWindowEnd <= 0) return "";

    const lines: string[] = [];
    for (let i = 0; i < windowCount; i++) {
      const windowEndAt = firstWindowEnd - i * windowMs;
      const windowStartAt = windowEndAt - windowMs;
      if (windowStartAt <= 0) break;

      const topic = this.db.getTopicByWindow(sessionId, windowStartAt, windowEndAt);
      if (!topic?.summary) continue;

      const keywords = this.parseKeywords(topic.keywords);
      const timeRange = `${this.formatTime(windowStartAt)} ~ ${this.formatTime(windowEndAt)}`;
      const keywordsLine =
        keywords.length > 0 ? ` | 关键词: ${keywords.join(", ")}` : "";
      lines.push(
        `- ${timeRange}: ${topic.summary.trim()}${keywordsLine}`,
      );
    }

    if (lines.length === 0) return "";

    return [
      "## Background Topics Outside Visible History (Reference Only)",
      "These summaries are rough references about older group discussions.",
      "Do not proactively bring them up unless users explicitly ask.",
      ...lines,
    ].join("\n");
  }

  private async analyzeWindow(
    sessionId: string,
    windowStartAt: number,
    windowEndAt: number,
    cfg = this.getConfig(extractGroupIdFromSession(sessionId)),
  ): Promise<void> {
    if (windowEndAt <= windowStartAt) return;

    const userMessages = this.db
      .getMessagesByTimeRange(sessionId, windowStartAt, windowEndAt)
      .filter((message) => message.role === "user" && message.content.trim());

    if (userMessages.length < 5) return;

    const existing = this.db.getTopicByWindow(sessionId, windowStartAt, windowEndAt);
    const messagesBlock = userMessages
      .map((message, index) => {
        const time = this.formatTime(message.timestamp);
        return `[${index + 1}][${time}] ${message.userName || "unknown"}: ${message.content}`;
      })
      .join("\n");

    try {
      const content = await this.ai.generateText({
        prompt: `You are a concise topic summarization assistant.

Only summarize the provided chat log within this exact time window:
${this.formatTime(windowStartAt)} ~ ${this.formatTime(windowEndAt)}

Rules:
1. Use ONLY messages from this log. Do not infer anything outside this 5-hour window.
2. The topic must be high-level, abstract, and concise.
3. The summary must be brief, not detailed.
4. Keep the output in the same language as the chat log.

Chat log:
${messagesBlock}

Output strictly in JSON format:
{
  "title": "short topic title",
  "keywords": ["keyword1", "keyword2"],
  "summary": "one concise abstract summary sentence"
}`,
        messages: [],
        model: cfg.workingModel || cfg.model,
        temperature: 0.2,
        max_tokens: 300,
      });

      const parsed = extractJsonObject(content);
      if (parsed === undefined) return;
      const summary = String(readField(parsed, "summary") || "").trim();
      if (!summary) return;

      const keywords = this.normalizeKeywords(readField(parsed, "keywords"));
      const title =
        String(readField(parsed, "title") || "").trim() ||
        `${this.formatTime(windowStartAt)} 话题概览`;

      if (existing?.id) {
        this.db.updateTopic(existing.id, {
          summary,
          keywords: JSON.stringify(keywords),
          messageCount: userMessages.length,
          updatedAt: windowEndAt,
        });
      } else {
        this.db.saveTopic({
          sessionId,
          title,
          keywords: JSON.stringify(keywords),
          summary,
          messageCount: userMessages.length,
          windowStartAt,
          windowEndAt,
          createdAt: windowEndAt,
          updatedAt: windowEndAt,
        });
      }

      logger.info(
        `[TopicTracker] Session ${sessionId}: summarized window ${this.formatTime(windowStartAt)} ~ ${this.formatTime(windowEndAt)} (${userMessages.length} user messages)`,
      );
    } catch (err) {
      logger.warn(`[TopicTracker] Analysis failed: ${err}`);
    }
  }

  private getWindowMs(cfg = this.getConfig()): number {
    const hours = Number(cfg.topic?.windowHours);
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 5;
    return Math.max(1, Math.floor(safeHours)) * 3600_000;
  }

  private getHistoryWindowCount(cfg = this.getConfig()): number {
    const count = Number(cfg.topic?.historyWindowCount);
    if (!Number.isFinite(count) || count <= 0) return 3;
    return Math.max(1, Math.floor(count));
  }

  private normalizeKeywords(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const cleaned = input
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return [...new Set(cleaned)].slice(0, 8);
  }

  private parseKeywords(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return this.normalizeKeywords(parsed);
    } catch {
      return [];
    }
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }
}

export type { ChatMessage };