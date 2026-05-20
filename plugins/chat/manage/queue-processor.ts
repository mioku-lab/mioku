import type { MiokiContext } from "mioki";
import type { AIInstance } from "../../../src/services/ai/types";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager, StructuredUserInput } from "./group-structured-history";
import type { SessionManager } from "./session";
import type { RateLimiter } from "./rate-limiter";
import type { MessageQueueManager } from "../utils/queue";
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
import { extractContent, getBotRole } from "../utils";

interface DynamicDelayQueueData {
  messages: Array<{ event: any; content: string; userName: string; userId: number; messageId: number; timestamp: number }>;
  timer: NodeJS.Timeout | null;
  delayUntil: number;
}

export class QueueProcessor {
  private dynamicDelayQueues = new Map<string, DynamicDelayQueueData>();

  constructor(
    private ctx: MiokiContext,
    private cfg: ChatConfig,
    private db: ChatDatabase,
    private humanize: HumanizeEngine,
    private aiInstance: AIInstance,
    private aiService: import("../../../src/services/ai/types").AIService,
    private skillManager: SkillSessionManager,
    private groupStructuredHistory: GroupStructuredHistoryManager,
    private sessionManager: SessionManager,
    private rateLimiter: RateLimiter,
    private queueManager: MessageQueueManager,
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
    private startCooldownTimer: (groupSessionId: string, groupId: number, selfId: number) => void,
  ) {}

  collectDynamicDelayMessage(groupSessionId: string, event: any, content: string): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = { messages: [], timer: null, delayUntil: 0 };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    const userName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    queueData.messages.push({ event, content, userName, userId: event.user_id, messageId: event.message_id, timestamp: Date.now() });
  }

  startDynamicDelayTimer(groupSessionId: string, groupId: number, delayMs: number, selfId: number): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = { messages: [], timer: null, delayUntil: Date.now() + delayMs };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    if (queueData.timer) clearTimeout(queueData.timer);
    queueData.delayUntil = Date.now() + delayMs;

    this.ctx.logger.info(`[DynamicDelay] group ${groupId} start delay ${delayMs / 1000}s, interactions: ${this.rateLimiter.getInteractionCount(groupId)}`);

    queueData.timer = setTimeout(async () => {
      await this.processDynamicDelayQueue(groupSessionId, groupId, selfId);
    }, delayMs);
  }

  isInDynamicDelay(groupSessionId: string): boolean {
    const queue = this.dynamicDelayQueues.get(groupSessionId);
    return queue != null && Date.now() < queue.delayUntil;
  }

  dispose(): void {
    for (const queue of this.dynamicDelayQueues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.dynamicDelayQueues.clear();
  }

  async processDynamicDelayQueue(groupSessionId: string, groupId: number, selfId: number): Promise<void> {
    const queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData || queueData.messages.length === 0) {
      this.dynamicDelayQueues.delete(groupSessionId);
      return;
    }

    const messages = queueData.messages;
    this.dynamicDelayQueues.delete(groupSessionId);

    this.ctx.logger.info(`[DynamicDelay] group ${groupId} processes ${messages.length} delayed messages`);
    this.rateLimiter.clearGroupInteractions(groupId);

    const mergedContents = messages.map((m) => m.content);
    const userNames = messages.map((m) => m.userName);
    const messageIds = messages.map((m) => m.messageId);
    const structuredUserInputs = messages.map((m) => this.buildStructuredUserInputFromEvent(m.event, m.content, m.timestamp));
    const mergedContent = mergedContents.join("\n---\n");
    const firstMsg = messages[0];

    const targetMessage: TargetMessage = {
      userName: userNames.join(", "), userId: firstMsg.userId, userRole: "member",
      content: mergedContent, messageId: firstMsg.messageId, timestamp: Date.now(),
    };

    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const botNickname = this.cfg.nicknames[0] || this.ctx.pickBot(selfId).nickname || "Bot";
    const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId, String(groupId));
    const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, this.cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, this.cfg));

    const toolCtx = this.buildToolContext({
      ctx: this.ctx, event: firstMsg.event, groupSessionId, groupId, userId: firstMsg.userId,
      config: this.cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
    });

    this.sessionManager.getOrCreate(groupSessionId, "group", groupId);
    const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);

    const result = await this.runWithRateLimitGuard(
      () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
        config: this.cfg, groupName, memberCount, botNickname, botRole, aiService: this.aiService, isGroup: true,
        memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
        replyContext: { type: "review", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        reviewMessages: { contents: mergedContents, userNames, messageIds },
      }, this.humanize, this.skillManager, {
        manager: this.groupStructuredHistory, ttlMs: this.cfg.groupStructuredHistoryTtlMs, currentUserInputs: structuredUserInputs,
      }),
      { userId: targetMessage.userId, groupId, label: "dynamic-delay" },
    );
    if (!result) return;

    await this.sendAIResponse({ ctx: this.ctx, groupId, messages: result.messages, config: this.cfg, sentIndices: toolCtx.sentMessageIndices }, selfId);
    this.startCooldownTimer(groupSessionId, groupId, selfId);
  }

  async processQueuedMessages(groupSessionId: string, selfId: number): Promise<void> {
    try {
      const queue = this.queueManager.getQueue(groupSessionId);
      if (!queue || queue.length === 0) {
        this.queueManager.clearActiveTarget(groupSessionId);
        return;
      }

      const groupId = parseInt(groupSessionId.split(":")[1], 10);
      this.ctx.logger.info(`[Queue] group ${groupSessionId} batch ${queue.length} messages`);

      const queuedContents: string[] = [];
      const structuredUserInputs: StructuredUserInput[] = [];

      for (const item of queue) {
        const { text: extractedText, multimodal } = extractContent(item.event, this.cfg, this.ctx);
        const content = multimodal ? JSON.stringify(multimodal) : extractedText;
        if (content) {
          queuedContents.push(content);
          structuredUserInputs.push(this.buildStructuredUserInputFromEvent(item.event, content, item.queuedAt));
        }
      }

      this.queueManager.clearQueue(groupSessionId);
      if (queuedContents.length === 0) {
        this.queueManager.clearActiveTarget(groupSessionId);
        return;
      }

      this.queueManager.clearActiveTarget(groupSessionId);

      const firstItem = queue[0];
      const userName = firstItem.event.sender?.card || firstItem.event.sender?.nickname || String(firstItem.event.user_id);
      const mergedContent = queuedContents.join("\n");

      const targetMessage: TargetMessage = {
        userName, userId: firstItem.event.user_id || firstItem.event.sender?.user_id,
        userRole: firstItem.event.sender?.role || "member", content: mergedContent,
        messageId: firstItem.event.message_id, timestamp: Date.now(),
      };

      const botRole = await getBotRole(groupId, this.ctx, selfId);
      const botNickname = this.cfg.nicknames[0] || this.ctx.pickBot(selfId).nickname || "Bot";
      const toolCtx = this.buildToolContext({
        ctx: this.ctx, event: null, groupSessionId, groupId, userId: targetMessage.userId,
        config: this.cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
      });

      const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, this.cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, this.cfg));
      const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);
      const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId);

      const result = await this.runWithRateLimitGuard(
        () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
          config: this.cfg, groupName, memberCount, botNickname, botRole: toolCtx.botRole, aiService: this.aiService, isGroup: true,
          memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
          replyContext: { type: "comment", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        }, this.humanize, this.skillManager, {
          manager: this.groupStructuredHistory, ttlMs: this.cfg.groupStructuredHistoryTtlMs, currentUserInputs: structuredUserInputs,
        }),
        { userId: targetMessage.userId, groupId, label: "queue" },
      );
      if (!result) return;

      await this.sendAIResponse({ ctx: this.ctx, groupId, messages: result.messages, config: this.cfg, sentIndices: toolCtx.sentMessageIndices }, selfId);
      await this.sendEmoji(this.ctx, groupId, result.emojiPath, selfId);
      const now = Date.now();
      this.saveBotMessages(groupId, groupSessionId, result.messages, now, this.cfg, this.db, this.ctx, selfId);
      this.sessionManager.touch(groupSessionId);
      this.ctx.logger.info(`[Queue] group ${groupSessionId} done`);
    } catch (err) {
      this.ctx.logger.error(err);
    }
  }
}