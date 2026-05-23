import type { AIInstance } from "mioku";
import { logger } from "mioki";
import type { ChatDatabase } from "../db";
import type { ChatConfig, ChatMessage } from "../types";

export interface MemoryUserHistoryChunk {
  userId: number;
  messages: ChatMessage[];
}

export interface MemoryRecallInput {
  sessionId: string;
  question: string;
  groupHistoryMessages?: ChatMessage[];
  userHistories?: MemoryUserHistoryChunk[];
  nowTimestamp?: number;
}

export class MemoryRetrieval {
  private ai: AIInstance;
  private config: ChatConfig;
  private db: ChatDatabase;

  constructor(ai: AIInstance, config: ChatConfig, db: ChatDatabase) {
    this.ai = ai;
    this.config = config;
    this.db = db;
  }

  async retrieveByQuestion(input: MemoryRecallInput): Promise<string | null> {
    if (!this.config.memory?.enabled) return null;

    const question = String(input.question || "").trim();
    if (!question) return null;

    const nowTs = input.nowTimestamp ?? Date.now();
    const nowText = this.formatTimestamp(nowTs);
    const recentContext = this.formatSessionMessages(
      this.db.getMessages(input.sessionId, 30),
    );
    const groupHistory = this.formatGroupHistory(input.groupHistoryMessages || []);
    const userHistory = this.formatUserHistories(input.userHistories || []);

    try {
      const result = await this.ai.generateText({
        prompt: `You are the memory worker model. You receive a recall question from the main chat model.
Current time: ${nowText}

Recall question:
${question}

Important:
- All provided records are historical logs, NOT messages sent just now.
- Every log already contains its send time/date. Use those timestamps carefully.
- If evidence is insufficient, clearly say what is missing instead of guessing.

Recent in-context chat snapshot (for orientation only):
${recentContext}

Group history fetched via message_id pagination (historical):
${groupHistory}

User history chunks (historical):
${userHistory}

Output requirements:
- Give one concise recall result for the main chat model.
- If useful evidence exists, summarize key facts with timestamps.
- If no useful memory exists, output exactly: NO_USEFUL_MEMORY_FOUND`,
        messages: [],
        model: this.config.workingModel || this.config.model,
        temperature: 0.2,
        max_tokens: 700,
      });

      const text = String(result || "").trim();
      if (!text || text.includes("NO_USEFUL_MEMORY_FOUND")) {
        return null;
      }
      return text;
    } catch (err) {
      logger.warn(`[MemoryRetrieval] Worker retrieval failed: ${err}`);
      return null;
    }
  }

  private formatSessionMessages(messages: ChatMessage[]): string {
    if (!messages.length) return "(none)";
    return messages
      .map((m) => {
        const name = m.userName || "unknown";
        return `[历史消息 | ${this.formatTimestamp(m.timestamp)}] ${name}: ${m.content}（不是刚刚发送）`;
      })
      .join("\n");
  }

  private formatGroupHistory(messages: ChatMessage[]): string {
    if (!messages.length) return "(none)";
    return messages
      .map((m) => {
        const name = m.userName || "unknown";
        const messageId = m.messageId ?? "unknown";
        return `[历史群聊 | ${this.formatTimestamp(m.timestamp)} | message_id:${messageId}] ${name}: ${m.content}（不是刚刚发送）`;
      })
      .join("\n");
  }

  private formatUserHistories(chunks: MemoryUserHistoryChunk[]): string {
    if (!chunks.length) return "(none)";

    const sections = chunks.map((chunk) => {
      if (!chunk.messages.length) {
        return `User ${chunk.userId}: (no historical messages)`;
      }

      const lines = chunk.messages.map((m) => {
        const name = m.userName || `user:${chunk.userId}`;
        const messageId = m.messageId ?? "unknown";
        return `[历史用户消息 | ${this.formatTimestamp(m.timestamp)} | message_id:${messageId}] ${name}: ${m.content}（不是刚刚发送）`;
      });

      return `User ${chunk.userId} history:\n${lines.join("\n")}`;
    });

    return sections.join("\n\n");
  }

  private formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  }
}
