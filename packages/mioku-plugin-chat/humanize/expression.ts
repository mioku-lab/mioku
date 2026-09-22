import type { AIInstance } from "mioku";
import { logger } from "mioku";
import { extractJsonObject } from "../utils/json";
import type { ChatDatabase } from "../db";
import type { ChatMessage } from "../types";
import type { ChatConfigProvider } from "./index";

export class ExpressionLearner {
  private ai: AIInstance;
  private getConfig: ChatConfigProvider;
  private db: ChatDatabase;
  private pendingMessagesByUser: Map<string, ChatMessage[]> = new Map();
  private learningUsers: Set<string> = new Set();

  constructor(ai: AIInstance, configProvider: ChatConfigProvider, db: ChatDatabase) {
    this.ai = ai;
    this.getConfig = configProvider;
    this.db = db;
  }

  async onMessage(message: ChatMessage): Promise<void> {
    const cfg = this.getConfig(message.groupId);
    if (!cfg.expression?.enabled) return;
    if (message.role !== "user") return;
    if (!message.content || message.content.length < 4) return;
    if (!message.userId) return;

    const pending = this.pendingMessagesByUser.get(message.userId) ?? [];
    pending.push(message);
    this.pendingMessagesByUser.set(message.userId, pending);

    await this.tryLearn(message.userId, cfg);
  }

  getExpressionContextForUser(
    userId: string,
    userName: string,
    groupId?: string,
  ): string {
    const cfg = this.getConfig(groupId);
    if (!cfg.expression?.enabled) return "";

    const sampleSize = cfg.expression?.sampleSize ?? 8;
    const expressions = this.db.getExpressionsByUser(userId, sampleSize);
    if (expressions.length === 0) {
      logger.info(
        `[ExpressionLearner] No expression habits found for user ${userName} (${userId})`,
      );
      return "";
    }
    const selected = expressions.slice(0, sampleSize);

    const habits = selected.map(
      (expr) =>
        `- When ${expr.situation}: ${expr.style} (e.g. "${expr.example}")`,
    );

    const context = `## Expression Habits\nExpression habits learned from ${userName}. If you are replying to this user, you may naturally reference these habits:\n${habits.join("\n")}`;
    logger.info(
      `[ExpressionLearner] Expression context for ${userName} (${userId}): ${habits.length} habits`,
    );
    return context;
  }

  private async tryLearn(userId: string, cfg = this.getConfig()): Promise<void> {
    if (this.learningUsers.has(userId)) return;

    const threshold = Math.max(
      1,
      cfg.expression?.learnAfterMessages ?? 100,
    );
    const pending = this.pendingMessagesByUser.get(userId) ?? [];
    logger.debug(
      `[ExpressionLearner] User ${userId} has ${pending.length}/${threshold} pending messages (threshold=${threshold})`,
    );
    if (pending.length < threshold) return;

    this.learningUsers.add(userId);
    try {
      while (true) {
        const current = this.pendingMessagesByUser.get(userId) ?? [];
        if (current.length < threshold) break;

        const batch = current.slice(0, threshold);
        this.pendingMessagesByUser.set(userId, current.slice(threshold));
        await this.learnForUser(userId, batch, cfg);
      }
    } catch (err) {
      logger.warn(
        `[ExpressionLearner] Learning failed for user ${userId}: ${err}`,
      );
    } finally {
      this.learningUsers.delete(userId);
    }
  }

  private async learnForUser(
    userId: string,
    messages: ChatMessage[],
    cfg = this.getConfig(),
  ): Promise<void> {
    if (messages.length === 0) return;

    const maxHabits = Math.max(1, cfg.expression?.sampleSize ?? 8);
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
      model: cfg.workingModel || cfg.model,
      temperature: 0.2,
      max_tokens: 600,
    });

    const parsed = extractJsonObject(content);
    if (parsed === undefined) return;
    if (!parsed.expressions || !Array.isArray(parsed.expressions)) return;

    const normalized = parsed.expressions
      .map((expr: any) => ({
        situation: String(expr?.situation ?? "").trim(),
        style: String(expr?.style ?? "").trim(),
        example: String(expr?.example ?? "").trim(),
      }))
      .filter((expr: { situation: string; style: string; example: string }) =>
        Boolean(expr.situation && expr.style && expr.example),
      )
      .slice(0, maxHabits);

    if (normalized.length === 0) return;

    this.db.replaceExpressionsByUser(userId, userName, normalized);

    const keepCount = Math.max(
      1,
      cfg.retention?.expressionKeepPerUser ?? maxHabits,
    );
    const pruned = this.db.pruneExpressionsBySession(
      `user:${userId}`,
      keepCount,
    );
    if (pruned > 0) {
      logger.info(
        `[ExpressionLearner] Pruned ${pruned} stale habits for user ${userId} (keep=${keepCount})`,
      );
    }

    logger.info(
      `[ExpressionLearner] Updated ${normalized.length} habits for ${userName} (${userId}): ${JSON.stringify(normalized)}`,
    );
  }
}