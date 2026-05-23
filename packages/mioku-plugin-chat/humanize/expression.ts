import type { AIInstance } from "mioku";
import { logger } from "mioki";
import type { ChatDatabase } from "../db";
import type { ChatConfig, ChatMessage } from "../types";

export class ExpressionLearner {
  private ai: AIInstance;
  private config: ChatConfig;
  private db: ChatDatabase;
  private pendingMessagesByUser: Map<number, ChatMessage[]> = new Map();
  private learningUsers: Set<number> = new Set();

  constructor(ai: AIInstance, config: ChatConfig, db: ChatDatabase) {
    this.ai = ai;
    this.config = config;
    this.db = db;
  }

  async onMessage(message: ChatMessage): Promise<void> {
    if (!this.config.expression?.enabled) return;
    if (message.role !== "user") return;
    if (!message.content || message.content.length < 4) return;
    if (!message.userId) return;

    const pending = this.pendingMessagesByUser.get(message.userId) ?? [];
    pending.push(message);
    this.pendingMessagesByUser.set(message.userId, pending);

    await this.tryLearn(message.userId);
  }

  getExpressionContextForUser(userId: number, userName: string): string {
    if (!this.config.expression?.enabled) return "";

    const sampleSize = this.config.expression?.sampleSize ?? 8;
    const expressions = this.db.getExpressionsByUser(userId, sampleSize);
    if (expressions.length === 0) {
      logger.info(`[ExpressionLearner] No expression habits found for user ${userName} (${userId})`);
      return "";
    }
    const selected = expressions.slice(0, sampleSize);

    const habits = selected.map(
      (expr) =>
        `- When ${expr.situation}: ${expr.style} (e.g. "${expr.example}")`,
    );

    const context = `## Expression Habits\nExpression habits learned from ${userName}. If you are replying to this user, you may naturally reference these habits:\n${habits.join("\n")}`;
    logger.info(`[ExpressionLearner] Expression context for ${userName} (${userId}): ${habits.length} habits`);
    return context;
  }

  private async tryLearn(userId: number): Promise<void> {
    if (this.learningUsers.has(userId)) return;

    const threshold = Math.max(
      1,
      this.config.expression?.learnAfterMessages ?? 100,
    );
    const pending = this.pendingMessagesByUser.get(userId) ?? [];
    logger.info(`[ExpressionLearner] User ${userId} has ${pending.length}/${threshold} pending messages (threshold=${threshold})`);
    if (pending.length < threshold) return;

    this.learningUsers.add(userId);
    try {
      while (true) {
        const current = this.pendingMessagesByUser.get(userId) ?? [];
        if (current.length < threshold) break;

        const batch = current.slice(0, threshold);
        this.pendingMessagesByUser.set(userId, current.slice(threshold));
        await this.learnForUser(userId, batch);
      }
    } catch (err) {
      logger.warn(`[ExpressionLearner] Learning failed for user ${userId}: ${err}`);
    } finally {
      this.learningUsers.delete(userId);
    }
  }

  private async learnForUser(
    userId: number,
    messages: ChatMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;

    const maxHabits = Math.max(1, this.config.expression?.sampleSize ?? 8);
    const userName = messages[messages.length - 1].userName || `User${userId}`;
    const msgTexts = messages.map((m) => m.content).join("\n");

    const previousExpressions = this.db.getExpressionsByUser(userId, maxHabits);
    const previousText =
      previousExpressions.length > 0
        ? previousExpressions
            .map(
              (expr, idx) =>
                `${idx + 1}. situation=${expr.situation}; style=${expr.style}; example=${expr.example}`,
            )
            .join("\n")
        : "None";

    const content = await this.ai.generateText({
      prompt: `You are refining expression habits for a single user named "${userName}".

New messages from this user:
${msgTexts}

Previously learned habits:
${previousText}

Task:
1. Merge previous habits and new evidence.
2. Remove weak or duplicated habits.
3. Output a revised list with at most ${maxHabits} habits.
4. situation/style/example must be in the SAME LANGUAGE as this user's messages.

Output strictly in JSON:
{"expressions":[{"situation":"...","style":"...","example":"..."}]}

If nothing reliable can be extracted, keep stable previous habits when possible. If still nothing, output {"expressions":[]}.`,
      messages: [],
      model: this.config.workingModel || this.config.model,
      temperature: 0.2,
      max_tokens: 600,
    });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.expressions || !Array.isArray(parsed.expressions)) return;

    const normalized = parsed.expressions
      .map((expr: any) => ({
        situation: String(expr?.situation ?? "").trim(),
        style: String(expr?.style ?? "").trim(),
        example: String(expr?.example ?? "").trim(),
      }))
      .filter(
        (expr: { situation: string; style: string; example: string }) =>
          Boolean(expr.situation && expr.style && expr.example),
      )
      .slice(0, maxHabits);

    if (normalized.length === 0) return;

    this.db.replaceExpressionsByUser(userId, userName, normalized);
    logger.info(
      `[ExpressionLearner] Updated ${normalized.length} habits for ${userName} (${userId}): ${JSON.stringify(normalized)}`,
    );
  }
}
