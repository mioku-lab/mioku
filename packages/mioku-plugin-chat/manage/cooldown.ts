import type { MiokiContext } from "mioki";
import type { AIInstance } from "mioku";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager, StructuredUserInput } from "./group-structured-history";
import type { SessionManager } from "./session";
import type { RateLimiter } from "./rate-limiter";
import type { IdleCheckManager } from "./idle-check";
import type {
  RunRateLimitGuard,
  HistoryMediaOptions,
  GetGroupHistoryMessages,
  GetGroupInfoData,
  GetHumanizeContexts,
  SendAIResponse,
  SaveBotMessages,
  SendEmoji,
  RunChat,
  BuildToolContext,
  BuildStructuredUserInput,
} from "./types";
import { getBotRole } from "../utils";

interface CooldownMessage {
  event: any;
  content: string;
  userName: string;
  userId: number;
  messageId: number;
  timestamp: number;
  isDirectAt: boolean;
}

export class CooldownManager {
  private groupCooldownUntil = new Map<string, number>();
  private groupCooldownMessages = new Map<string, CooldownMessage[]>();
  private cooldownTimeoutIds = new Map<string, NodeJS.Timeout>();

  constructor(
    private ctx: MiokiContext,
    private cfg: ChatConfig,
    private db: ChatDatabase,
    private humanize: HumanizeEngine,
    private aiInstance: AIInstance,
    private aiService: import("mioku").AIService,
    private skillManager: SkillSessionManager,
    private groupStructuredHistory: GroupStructuredHistoryManager,
    private sessionManager: SessionManager,
    private rateLimiter: RateLimiter,
    private idleCheckManager: IdleCheckManager,
    private runWithRateLimitGuard: RunRateLimitGuard,
    private buildHistoryMediaOptions: (ai: AIInstance, cfg: ChatConfig) => HistoryMediaOptions,
    private getGroupHistoryMessages: GetGroupHistoryMessages,
    private getGroupInfoData: GetGroupInfoData,
    private getHumanizeContexts: GetHumanizeContexts,
    private sendAIResponse: SendAIResponse,
    private saveBotMessages: SaveBotMessages,
    private sendEmoji: SendEmoji,
    private runChat: RunChat,
    private buildToolContext: BuildToolContext,
    private buildStructuredUserInputFromEvent: BuildStructuredUserInput,
  ) {}

  startCooldownTimer(groupSessionId: string, groupId: number, selfId: number): void {
    const existingTimer = this.cooldownTimeoutIds.get(groupSessionId);
    if (existingTimer) clearTimeout(existingTimer);

    const cooldownMs = this.cfg.cooldownAfterReplyMs ?? 20_000;

    const timer = setTimeout(async () => {
      this.cooldownTimeoutIds.delete(groupSessionId);
      const collected = this.groupCooldownMessages.get(groupSessionId) || [];
      if (collected.length === 0) {
        this.groupCooldownMessages.delete(groupSessionId);
        this.groupCooldownUntil.delete(groupSessionId);
        return;
      }

      const directAtMessages = collected.filter((m) => m.isDirectAt);
      try {
        if (directAtMessages.length > 0) {
          await this.processReviewMessages(groupSessionId, groupId, collected, selfId);
        } else {
          await this.processCooldownWithPlanner(groupSessionId, groupId, collected, selfId);
        }
      } catch (err) {
        this.ctx.logger.error(`[Cooldown] Group ${groupId} processing failed: ${err}`);
      } finally {
        this.groupCooldownMessages.delete(groupSessionId);
        this.groupCooldownUntil.delete(groupSessionId);
      }
    }, cooldownMs);

    this.cooldownTimeoutIds.set(groupSessionId, timer);
    this.groupCooldownUntil.set(groupSessionId, Date.now() + cooldownMs);
    this.groupCooldownMessages.set(groupSessionId, []);
  }

  collectMessage(groupSessionId: string, groupId: number, event: any, content: string, isDirectAt: boolean): void {
    const userName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    const messages = this.groupCooldownMessages.get(groupSessionId) || [];
    messages.push({ event, content, userName, userId: event.user_id, messageId: event.message_id, timestamp: Date.now(), isDirectAt });
    this.groupCooldownMessages.set(groupSessionId, messages);
  }

  isInCooldown(groupSessionId: string): boolean {
    return Date.now() < (this.groupCooldownUntil.get(groupSessionId) ?? 0);
  }

  dispose(): void {
    for (const timer of this.cooldownTimeoutIds.values()) clearTimeout(timer);
    this.cooldownTimeoutIds.clear();
    this.groupCooldownUntil.clear();
    this.groupCooldownMessages.clear();
  }

  private async processReviewMessages(groupSessionId: string, groupId: number, collected: CooldownMessage[], selfId: number): Promise<void> {
    const mergedContents = collected.map((m) => m.content);
    const userNames = collected.map((m) => m.userName);
    const messageIds = collected.map((m) => m.messageId);
    const mergedContent = mergedContents.join("\n---\n");
    const firstMsg = collected[0];

    const targetMessage: TargetMessage = {
      userName: userNames.join(", "),
      userId: firstMsg.userId,
      userRole: firstMsg.event.sender?.role || "member",
      content: mergedContent,
      messageId: firstMsg.messageId,
      timestamp: Date.now(),
    };

    const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, this.cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, this.cfg));
    const botNickname = this.cfg.nicknames[0] || this.ctx.pickBot(selfId).nickname || "Bot";
    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId);

    const toolCtx = this.buildToolContext({
      ctx: this.ctx, event: firstMsg.event, groupSessionId, groupId, userId: targetMessage.userId,
      config: this.cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
    });

    const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);

    const result = await this.runWithRateLimitGuard(
      () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
        config: this.cfg, groupName, memberCount, botNickname, botRole, aiService: this.aiService, isGroup: true,
        memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
        replyContext: { type: "review", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        reviewMessages: { contents: mergedContents, userNames, messageIds },
      }, this.humanize, this.skillManager, {
        manager: this.groupStructuredHistory, ttlMs: this.cfg.groupStructuredHistoryTtlMs,
        currentUserInputs: collected.map((msg) => this.buildStructuredUserInputFromEvent(msg.event, msg.content, msg.timestamp)),
      }),
      { userId: targetMessage.userId, groupId, label: "cooldown" },
    );
    if (!result) return;

    await this.sendAIResponse({ ctx: this.ctx, groupId, messages: result.messages, config: this.cfg, sentIndices: toolCtx.sentMessageIndices }, selfId);
    await this.sendEmoji(this.ctx, groupId, result.emojiPath, selfId);

    const now = Date.now();
    this.saveBotMessages(groupId, groupSessionId, result.messages, now, this.cfg, this.db, this.ctx, selfId);
    this.idleCheckManager.recordBotMessages(groupSessionId, result.messages.length, selfId);
    this.sessionManager.touch(groupSessionId);
    this.startCooldownTimer(groupSessionId, groupId, selfId);
  }

  private async processCooldownWithPlanner(groupSessionId: string, groupId: number, collected: CooldownMessage[], selfId: number): Promise<void> {
    const mergedContent = collected.map((m) => m.content).join("\n");
    const firstMsg = collected[0];

    const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, this.cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, this.cfg));
    const botNickname = this.cfg.nicknames[0] || this.ctx.pickBot(selfId).nickname || "Bot";

    const planResult = await this.humanize.actionPlanner.plan(groupSessionId, botNickname, history, mergedContent);
    if (planResult.action !== "reply") {
      this.ctx.logger.info(`[CooldownPlanner] Group ${groupId} planner decided not to reply: ${planResult.reason}`);
      return;
    }

    const targetMessage: TargetMessage = {
      userName: firstMsg.userName, userId: firstMsg.userId,
      userRole: firstMsg.event.sender?.role || "member", content: mergedContent,
      messageId: firstMsg.messageId, timestamp: Date.now(),
    };

    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const toolCtx = this.buildToolContext({
      ctx: this.ctx, event: firstMsg.event, groupSessionId, groupId, userId: targetMessage.userId,
      config: this.cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
    });
    const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId);
    const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);
    const plannerThoughts = `After you spoke, the following messages were sent in the group. Use this context to respond naturally.\nPlanned reason: ${planResult.reason}`;

    const result = await this.runWithRateLimitGuard(
      () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
        config: this.cfg, groupName, memberCount, botNickname, botRole: toolCtx.botRole, aiService: this.aiService, isGroup: true,
        memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
        plannerThoughts,
        replyContext: { type: "comment", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        reviewMessages: { contents: collected.map((m) => m.content), userNames: collected.map((m) => m.userName), messageIds: collected.map((m) => m.messageId) },
      }, this.humanize, this.skillManager, {
        manager: this.groupStructuredHistory, ttlMs: this.cfg.groupStructuredHistoryTtlMs,
        currentUserInputs: collected.map((msg) => this.buildStructuredUserInputFromEvent(msg.event, msg.content, msg.timestamp)),
      }),
      { userId: targetMessage.userId, groupId, label: "cooldown-planner" },
    );
    if (!result) {
      this.ctx.logger.warn(`[CooldownPlanner] Group ${groupId} AI request skipped`);
      return;
    }

    await this.sendAIResponse({ ctx: this.ctx, groupId, messages: result.messages, config: this.cfg, sentIndices: toolCtx.sentMessageIndices }, selfId);
    await this.sendEmoji(this.ctx, groupId, result.emojiPath, selfId);
    const now = Date.now();
    this.saveBotMessages(groupId, groupSessionId, result.messages, now, this.cfg, this.db, this.ctx, selfId);
    this.idleCheckManager.recordBotMessages(groupSessionId, result.messages.length, selfId);
    this.sessionManager.touch(groupSessionId);
    this.startCooldownTimer(groupSessionId, groupId, selfId);
  }
}