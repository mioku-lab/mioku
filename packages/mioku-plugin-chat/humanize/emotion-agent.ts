import type { AIInstance } from "mioku";
import { logger } from "mioku";
import { extractJsonObject } from "../utils/json";
import type { ChatConfig, ChatMessage, TargetMessage } from "../types";
import { extractGroupIdFromSession } from "../utils/group-config";
import type { ChatConfigProvider } from "./index";

export interface EmotionState {
  current: string;
  updatedAt: number;
}

export interface EmotionAnalysisInput {
  sessionId: string;
  botNickname: string;
  chatHistory: ChatMessage[];
  targetMessage: TargetMessage;
  force?: boolean;
}

export class EmotionAgent {
  private readonly ai: AIInstance;
  private readonly getConfig: ChatConfigProvider;
  private readonly states = new Map<string, EmotionState>();

  constructor(ai: AIInstance, configProvider: ChatConfigProvider) {
    this.ai = ai;
    this.getConfig = configProvider;
  }

  getCurrent(sessionId: string): EmotionState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;

    const current = this.getDefaultEmotion(extractGroupIdFromSession(sessionId));
    const state = { current, updatedAt: 0 };
    this.states.set(sessionId, state);
    return state;
  }

  getAvailableEmotions(groupId?: string): string[] {
    const cfg = this.getConfig(groupId);
    const emotions = Object.keys(cfg.emotion?.emotions || {})
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    return Array.from(new Set(["default", ...emotions]));
  }

  getReferenceExamples(emotion: string, groupId?: string): string[] {
    const cfg = this.getConfig(groupId);
    const normalized = this.normalizeEmotionName(emotion);
    const emotions = cfg.emotion?.emotions || {};
    const examples = this.normalizeExamples(emotions[normalized]?.examples);
    if (examples.length > 0) return examples;
    return this.normalizeExamples(emotions[this.getDefaultEmotion(groupId)]?.examples);
  }

  setEmotion(sessionId: string, emotion: string, groupId?: string): EmotionState {
    const current = this.resolveEmotion(emotion, groupId);
    const state = { current, updatedAt: Date.now() };
    this.states.set(sessionId, state);
    return state;
  }

  parseEmotionIntent(text: string): string | null {
    const match = String(text || "").match(/\[emotion:([^\]]+)]/i);
    if (!match) return null;
    return this.normalizeEmotionName(match[1]);
  }

  cleanEmotionMarkers(text: string): string {
    return String(text || "").replace(/\[emotion:[^\]]+]/gi, "");
  }

  async refreshIfNeeded(input: EmotionAnalysisInput): Promise<EmotionState> {
    const groupId = extractGroupIdFromSession(input.sessionId);
    const cfg = this.getConfig(groupId);
    const current = this.getCurrent(input.sessionId);
    const intervalMs = Number(cfg.emotion?.updateIntervalMs ?? 60 * 60_000);
    const shouldRefresh =
      Boolean(input.force) || current.updatedAt <= 0 || Date.now() - current.updatedAt >= intervalMs;

    if (!shouldRefresh) return current;

    try {
      const nextEmotion = await this.analyzeEmotion(input, cfg);
      return this.setEmotion(input.sessionId, nextEmotion, groupId);
    } catch (err) {
      logger.warn(`[emotion-agent] emotion analysis failed: ${err}`);
      if (current.updatedAt <= 0) {
        return this.setEmotion(input.sessionId, this.getDefaultEmotion(groupId), groupId);
      }
      return current;
    }
  }

  private async analyzeEmotion(input: EmotionAnalysisInput, cfg: ChatConfig = this.getConfig(extractGroupIdFromSession(input.sessionId))): Promise<string> {
    const availableEmotions = this.getAvailableEmotions(extractGroupIdFromSession(input.sessionId));
    const model = cfg.workingModel || cfg.model;
    const systemPrompt = `You are an emotion state selector for a chat bot.

Task:
- Read the recent chat context and the target user message.
- Choose exactly one current emotion state for ${input.botNickname}.
- Only choose from the available emotion names.
- Do not decide how the bot should reply.
- Do not mention tools, actions, or response strategy.
- Return JSON only.

Available emotions: ${availableEmotions.join(", ")}

Response format:
{"emotion":"one_available_emotion","reason":"brief context-only reason"}`;

    const historyText = input.chatHistory
      .slice(-30)
      .map((msg) => {
        const role = msg.role === "assistant" ? input.botNickname : msg.userName || "User";
        const time = new Date(msg.timestamp);
        const timeStr = `${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
        return `[${timeStr}] ${role}: ${msg.content}`;
      })
      .join("\n");

    const userPrompt = `Recent chat context:
${historyText || "(No recent messages)"}

Target user message:
${input.targetMessage.userName}: ${input.targetMessage.content}`;

    const response = await this.ai.complete({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 160,
    });

    const content = response.content || "";
    const parsed = extractJsonObject(content);
    if (parsed === undefined) return this.getDefaultEmotion(extractGroupIdFromSession(input.sessionId));
    return this.resolveEmotion(parsed?.emotion, extractGroupIdFromSession(input.sessionId));
  }

  private resolveEmotion(emotion: unknown, groupId?: string): string {
    const normalized = this.normalizeEmotionName(emotion);
    const available = this.getAvailableEmotions(groupId);
    if (available.includes(normalized)) return normalized;
    return this.getDefaultEmotion(groupId);
  }

  private getDefaultEmotion(groupId?: string): string {
    const cfg = this.getConfig(groupId);
    const configured = this.normalizeEmotionName(cfg.emotion?.defaultEmotion);
    const available = this.getAvailableEmotions(groupId);
    return available.includes(configured) ? configured : "default";
  }

  private normalizeEmotionName(emotion: unknown): string {
    return String(emotion || "").trim().toLowerCase();
  }

  private normalizeExamples(examples: unknown): string[] {
    if (!Array.isArray(examples)) return [];
    return examples.map((item) => String(item || "").trim()).filter(Boolean);
  }
}
