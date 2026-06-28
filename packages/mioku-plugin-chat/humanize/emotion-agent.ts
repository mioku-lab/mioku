import type { AIInstance } from "mioku";
import { logger } from "mioki";
import type { ChatConfig, ChatMessage, TargetMessage } from "../types";

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
  private readonly config: ChatConfig;
  private readonly states = new Map<string, EmotionState>();

  constructor(ai: AIInstance, config: ChatConfig) {
    this.ai = ai;
    this.config = config;
  }

  getCurrent(sessionId: string): EmotionState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;

    const current = this.getDefaultEmotion();
    const state = { current, updatedAt: 0 };
    this.states.set(sessionId, state);
    return state;
  }

  getAvailableEmotions(): string[] {
    const emotions = Object.keys(this.config.emotion?.emotions || {})
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    return Array.from(new Set(["default", ...emotions]));
  }

  getReferenceExamples(emotion: string): string[] {
    const normalized = this.normalizeEmotionName(emotion);
    const emotions = this.config.emotion?.emotions || {};
    const examples = this.normalizeExamples(emotions[normalized]?.examples);
    if (examples.length > 0) return examples;
    return this.normalizeExamples(emotions[this.getDefaultEmotion()]?.examples);
  }

  setEmotion(sessionId: string, emotion: string): EmotionState {
    const current = this.resolveEmotion(emotion);
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
    const current = this.getCurrent(input.sessionId);
    const intervalMs = Number(this.config.emotion?.updateIntervalMs ?? 60 * 60_000);
    const shouldRefresh =
      Boolean(input.force) || current.updatedAt <= 0 || Date.now() - current.updatedAt >= intervalMs;

    if (!shouldRefresh) return current;

    try {
      const nextEmotion = await this.analyzeEmotion(input);
      return this.setEmotion(input.sessionId, nextEmotion);
    } catch (err) {
      logger.warn(`[emotion-agent] emotion analysis failed: ${err}`);
      if (current.updatedAt <= 0) {
        return this.setEmotion(input.sessionId, this.getDefaultEmotion());
      }
      return current;
    }
  }

  private async analyzeEmotion(input: EmotionAnalysisInput): Promise<string> {
    const availableEmotions = this.getAvailableEmotions();
    const model = this.config.workingModel || this.config.model;
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
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return this.getDefaultEmotion();

    const parsed = JSON.parse(jsonMatch[0]);
    return this.resolveEmotion(parsed?.emotion);
  }

  private resolveEmotion(emotion: unknown): string {
    const normalized = this.normalizeEmotionName(emotion);
    const available = this.getAvailableEmotions();
    if (available.includes(normalized)) return normalized;
    return this.getDefaultEmotion();
  }

  private getDefaultEmotion(): string {
    const configured = this.normalizeEmotionName(this.config.emotion?.defaultEmotion);
    const available = this.getAvailableEmotions();
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
