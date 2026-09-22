import type { MiokuContext } from "mioku";
import type { AIInstance } from "mioku";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine, ChatConfigProvider } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager, StructuredUserInput } from "./group-structured-history";
import { buildStructuredUserInputFromEvent } from "./group-structured-history";
import type { SessionManager } from "./session";
import type { RateLimiter } from "./rate-limiter";
import type { MessageQueueManager } from "../utils/queue";
import type {
  RunRateLimitGuard,
  HistoryMediaOptions,
  GetGroupHistoryMessages,
  GetGroupInfoData,
  GetHumanizeContexts,
  RunChat,
  BuildToolContext,
  BuildStructuredUserInput,
} from "./types";
import type { ChatPluginContext } from "../context";
import type { SessionTurnScheduler } from "./session-turn-scheduler";
import { finalizeChatTurn } from "../core/chat-turn";
import { extractContent, getBotRole } from "../utils";

interface DynamicDelayQueueData {
  messages: Array<{ event: any; content: string; userName: string; userId: string; messageId: string; timestamp: number }>;
  timer: NodeJS.Timeout | null;
  delayUntil: number;
}

export class QueueProcessor {
  private dynamicDelayQueues = new Map<string, DynamicDelayQueueData>();
  private pluginCtx: ChatPluginContext;

  private ctx: MiokuContext;
  private configProvider: ChatConfigProvider;
  private defaultConfig: ChatConfig;
  private db: ChatDatabase;
  private humanize: HumanizeEngine;
  private aiInstance: AIInstance;
  private aiService: import("mioku").AIService;
  private skillManager: SkillSessionManager;
  private groupStructuredHistory: GroupStructuredHistoryManager;
  private sessionManager: SessionManager;
  private rateLimiter: RateLimiter;
  private queueManager: MessageQueueManager;
  private runWithRateLimitGuard: RunRateLimitGuard;
  private buildHistoryMediaOptions: (ai: AIInstance, cfg: ChatConfig) => HistoryMediaOptions;
  private getGroupHistoryMessages: GetGroupHistoryMessages;
  private getGroupInfoData: GetGroupInfoData;
  private getHumanizeContexts: GetHumanizeContexts;
  private runChat: RunChat;
  private buildToolContext: BuildToolContext;
  private buildStructuredUserInputFromEvent: BuildStructuredUserInput;
  private sessionTurnScheduler: SessionTurnScheduler;

  constructor(pluginCtx: ChatPluginContext) {
    this.pluginCtx = pluginCtx;
    this.ctx = pluginCtx.ctx;
    this.configProvider = pluginCtx.configProvider;
    this.defaultConfig = pluginCtx.defaultConfig;
    this.db = pluginCtx.db;
    this.humanize = pluginCtx.humanize;
    this.aiInstance = pluginCtx.aiInstance;
    this.aiService = pluginCtx.aiService;
    this.skillManager = pluginCtx.skillManager;
    this.groupStructuredHistory = pluginCtx.groupStructuredHistory;
    this.sessionManager = pluginCtx.sessionManager;
    this.rateLimiter = pluginCtx.rateLimiter;
    this.queueManager = pluginCtx.queueManager;
    this.runWithRateLimitGuard = pluginCtx.runWithRateLimitGuard;
    this.buildHistoryMediaOptions = pluginCtx.buildHistoryMediaOptions;
    this.getGroupHistoryMessages = pluginCtx.getGroupHistoryMessages;
    this.getGroupInfoData = pluginCtx.getGroupInfoData;
    this.getHumanizeContexts = pluginCtx.getHumanizeContexts;
    this.runChat = pluginCtx.runChat;
    this.buildToolContext = pluginCtx.buildToolContext;
    this.buildStructuredUserInputFromEvent = buildStructuredUserInputFromEvent;
    this.sessionTurnScheduler = pluginCtx.sessionTurnScheduler;
  }

  collectDynamicDelayMessage(groupSessionId: string, event: any, content: string): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = { messages: [], timer: null, delayUntil: 0 };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    const userName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    queueData.messages.push({ event, content, userName, userId: event.user_id, messageId: event.message_id, timestamp: Date.now() });
  }

  startDynamicDelayTimer(groupSessionId: string, groupId: string, delayMs: number, selfId: string): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = { messages: [], timer: null, delayUntil: Date.now() + delayMs };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    if (queueData.timer) clearTimeout(queueData.timer);
    queueData.delayUntil = Date.now() + delayMs;

    this.ctx.logger.info(`[DynamicDelay] group ${groupId} start delay ${delayMs / 1000}s, interactions: ${this.rateLimiter.getInteractionCount(groupId)}`);

    const timer = setTimeout(() => {
      const current = this.dynamicDelayQueues.get(groupSessionId);
      if (!current || current !== queueData || current.timer !== timer) return;
      this.dynamicDelayQueues.delete(groupSessionId);
      current.timer = null;
      const messages = current.messages;
      if (messages.length === 0) return;
      void this.sessionTurnScheduler
        .run(groupSessionId, "dynamic-delay", () =>
          this.processDynamicDelayMessages(
            groupSessionId,
            groupId,
            selfId,
            messages,
          ),
        )
        .catch((err) =>
          this.ctx.logger.error(
            `[DynamicDelay] group ${groupId} processing failed: ${err}`,
          ),
        );
    }, delayMs);
    queueData.timer = timer;
  }

  isInDynamicDelay(groupSessionId: string): boolean {
    const queue = this.dynamicDelayQueues.get(groupSessionId);
    return queue != null && Date.now() < queue.delayUntil;
  }

  scheduleQueuedMessages(groupSessionId: string, selfId: string): void {
    void this.sessionTurnScheduler
      .run(
        groupSessionId,
        "queued-message",
        () => this.processQueuedMessages(groupSessionId, selfId),
        { dedupeKey: `queued-message:${selfId}` },
      )
      .catch((err) =>
        this.ctx.logger.error(
          `[Queue] group ${groupSessionId} scheduling failed: ${err}`,
        ),
      );
  }

  dispose(): void {
    for (const queue of this.dynamicDelayQueues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.dynamicDelayQueues.clear();
  }

  private async processDynamicDelayMessages(
    groupSessionId: string,
    groupId: string,
    selfId: string,
    messages: DynamicDelayQueueData["messages"],
  ): Promise<void> {
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

    const cfg = this.configProvider(groupId);
    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const botNickname = cfg.nicknames[0] || this.ctx.pickBot(selfId)?.nickname || "Bot";
    const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId, String(groupId));
    const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, cfg));

    const toolCtx = this.buildToolContext({
      ctx: this.ctx, event: firstMsg.event, groupSessionId, groupId, userId: firstMsg.userId,
      config: cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
      audioService: this.pluginCtx.audioService,
    });

    this.sessionManager.getOrCreate(groupSessionId, "group", groupId);
    const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);

    const result = await this.runWithRateLimitGuard(
      () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
        config: cfg, groupName, memberCount, botNickname, botRole, aiService: this.aiService, isGroup: true,
        memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
        replyContext: { type: "review", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        reviewMessages: { contents: mergedContents, userNames, messageIds },
      }, this.humanize, this.skillManager, {
        manager: this.groupStructuredHistory, ttlMs: cfg.groupStructuredHistoryTtlMs, currentUserInputs: structuredUserInputs,
      }),
      { userId: targetMessage.userId, groupId, label: "dynamic-delay", skipRetryOnRateLimit: true },
    );
    if (!result) return;

    await finalizeChatTurn(this.pluginCtx, {
      event: firstMsg.event,
      cfg,
      result,
      groupId,
      groupSessionId,
      userId: targetMessage.userId,
      selfId,
      toolCtx,
      send: true,
      isLive: true,
    });
  }

  async processQueuedMessages(groupSessionId: string, selfId: string): Promise<void> {
    try {
      const queue = this.queueManager.getQueue(groupSessionId);
      if (!queue || queue.length === 0) {
        this.queueManager.clearActiveTarget(groupSessionId);
        return;
      }

      const groupId = String(groupSessionId.split(":")[1] ?? "").trim();
      if (!groupId) return;
      this.ctx.logger.info(`[Queue] group ${groupSessionId} batch ${queue.length} messages`);

      const queuedContents: string[] = [];
      const structuredUserInputs: StructuredUserInput[] = [];

      const cfg = this.configProvider(groupId);

      for (const item of queue) {
        const { text: extractedText, multimodal } = extractContent(item.event, cfg, this.ctx);
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
        userName, userId: String(firstItem.event.user_id ?? firstItem.event.sender?.user_id ?? "").trim(),
        userRole: firstItem.event.sender?.role || "member", content: mergedContent,
        messageId: firstItem.event.message_id, timestamp: Date.now(),
      };

      const botRole = await getBotRole(groupId, this.ctx, selfId);
      const botNickname = cfg.nicknames[0] || this.ctx.pickBot(selfId)?.nickname || "Bot";
      const toolCtx = this.buildToolContext({
        ctx: this.ctx, event: null, groupSessionId, groupId, userId: targetMessage.userId,
        config: cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
        audioService: this.pluginCtx.audioService,
      });

      const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, cfg));
      const contexts = await this.getHumanizeContexts(this.humanize, groupSessionId, targetMessage.userName, history, targetMessage.userId);
      const { groupName, memberCount } = await this.getGroupInfoData(this.ctx, groupId, selfId);

      const result = await this.runWithRateLimitGuard(
        () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
          config: cfg, groupName, memberCount, botNickname, botRole: toolCtx.botRole, aiService: this.aiService, isGroup: true,
          memoryContext: contexts.memoryContext, topicContext: contexts.topicContext, expressionContext: contexts.expressionContext,
          replyContext: { type: "comment", targetUser: targetMessage.userName, targetMessage: targetMessage.content },
        }, this.humanize, this.skillManager, {
          manager: this.groupStructuredHistory, ttlMs: cfg.groupStructuredHistoryTtlMs, currentUserInputs: structuredUserInputs,
        }),
        { userId: targetMessage.userId, groupId, label: "queue", skipRetryOnRateLimit: true },
      );
      if (!result) return;

      await finalizeChatTurn(this.pluginCtx, {
        event: firstItem.event,
        cfg,
        result,
        groupId,
        groupSessionId,
        userId: targetMessage.userId,
        selfId,
        toolCtx,
        send: true,
        isLive: true,
      });
      this.ctx.logger.info(`[Queue] group ${groupSessionId} done`);
    } catch (err) {
      this.ctx.logger.error(err);
    }
  }
}