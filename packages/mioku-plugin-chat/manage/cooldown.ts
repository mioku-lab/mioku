import type { MiokuContext } from "mioku";
import type { AIInstance } from "mioku";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine, ChatConfigProvider } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager } from "./group-structured-history";
import { buildStructuredUserInputFromEvent } from "./group-structured-history";
import type { RateLimiter } from "./rate-limiter";
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
import { getBotRole } from "../utils";

interface CooldownMessage {
  event: any;
  content: string;
  userName: string;
  userId: string;
  messageId: string;
  timestamp: number;
  isDirectAt: boolean;
}

export class CooldownManager {
  private groupCooldownUntil = new Map<string, number>();
  private groupCooldownMessages = new Map<string, CooldownMessage[]>();
  private cooldownTimeoutIds = new Map<string, NodeJS.Timeout>();
  private pluginCtx: ChatPluginContext;
  private sessionTurnScheduler: SessionTurnScheduler;

  private ctx: MiokuContext;
  private configProvider: ChatConfigProvider;
  private defaultConfig: ChatConfig;
  private db: ChatDatabase;
  private humanize: HumanizeEngine;
  private aiInstance: AIInstance;
  private aiService: import("mioku").AIService;
  private skillManager: SkillSessionManager;
  private groupStructuredHistory: GroupStructuredHistoryManager;
  private rateLimiter: RateLimiter;
  private runWithRateLimitGuard: RunRateLimitGuard;
  private buildHistoryMediaOptions: (
    ai: AIInstance,
    cfg: ChatConfig,
  ) => HistoryMediaOptions;
  private getGroupHistoryMessages: GetGroupHistoryMessages;
  private getGroupInfoData: GetGroupInfoData;
  private getHumanizeContexts: GetHumanizeContexts;
  private runChat: RunChat;
  private buildToolContext: BuildToolContext;
  private buildStructuredUserInputFromEvent: BuildStructuredUserInput;

  constructor(pluginCtx: ChatPluginContext) {
    this.pluginCtx = pluginCtx;
    this.sessionTurnScheduler = pluginCtx.sessionTurnScheduler;
    this.ctx = pluginCtx.ctx;
    this.configProvider = pluginCtx.configProvider;
    this.defaultConfig = pluginCtx.defaultConfig;
    this.db = pluginCtx.db;
    this.humanize = pluginCtx.humanize;
    this.aiInstance = pluginCtx.aiInstance;
    this.aiService = pluginCtx.aiService;
    this.skillManager = pluginCtx.skillManager;
    this.groupStructuredHistory = pluginCtx.groupStructuredHistory;
    this.rateLimiter = pluginCtx.rateLimiter;
    this.runWithRateLimitGuard = pluginCtx.runWithRateLimitGuard;
    this.buildHistoryMediaOptions = pluginCtx.buildHistoryMediaOptions;
    this.getGroupHistoryMessages = pluginCtx.getGroupHistoryMessages;
    this.getGroupInfoData = pluginCtx.getGroupInfoData;
    this.getHumanizeContexts = pluginCtx.getHumanizeContexts;
    this.runChat = pluginCtx.runChat;
    this.buildToolContext = pluginCtx.buildToolContext;
    this.buildStructuredUserInputFromEvent = buildStructuredUserInputFromEvent;
  }

  startCooldownTimer(
    groupSessionId: string,
    groupId: string,
    selfId: string,
  ): void {
    const existingTimer = this.cooldownTimeoutIds.get(groupSessionId);
    if (existingTimer) clearTimeout(existingTimer);

    const cfg = this.configProvider(groupId);
    const cooldownMs =
      cfg.cooldownAfterReplyMs ??
      this.defaultConfig.cooldownAfterReplyMs ??
      20_000;

    const timer = setTimeout(() => {
      if (this.cooldownTimeoutIds.get(groupSessionId) !== timer) return;
      this.cooldownTimeoutIds.delete(groupSessionId);
      this.groupCooldownUntil.delete(groupSessionId);
      const collected = this.groupCooldownMessages.get(groupSessionId) || [];
      this.groupCooldownMessages.delete(groupSessionId);
      if (collected.length === 0) return;

      const hasDirectAt = collected.some((message) => message.isDirectAt);
      void this.sessionTurnScheduler
        .run(
          groupSessionId,
          hasDirectAt ? "cooldown" : "cooldown-planner",
          () =>
            hasDirectAt
              ? this.processReviewMessages(
                  groupSessionId,
                  groupId,
                  collected,
                  selfId,
                )
              : this.processCooldownWithPlanner(
                  groupSessionId,
                  groupId,
                  collected,
                  selfId,
                ),
        )
        .catch((err) =>
          this.ctx.logger.error(
            `[Cooldown] Group ${groupId} processing failed: ${err}`,
          ),
        );
    }, cooldownMs);

    this.cooldownTimeoutIds.set(groupSessionId, timer);
    this.groupCooldownUntil.set(groupSessionId, Date.now() + cooldownMs);
    if (!this.groupCooldownMessages.has(groupSessionId)) {
      this.groupCooldownMessages.set(groupSessionId, []);
    }
  }

  collectMessage(
    groupSessionId: string,
    groupId: string,
    event: any,
    content: string,
    isDirectAt: boolean,
  ): void {
    const userName =
      event.sender?.card || event.sender?.nickname || String(event.user_id);
    const messages = this.groupCooldownMessages.get(groupSessionId) || [];
    messages.push({
      event,
      content,
      userName,
      userId: event.user_id,
      messageId: event.message_id,
      timestamp: Date.now(),
      isDirectAt,
    });
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

  private async processReviewMessages(
    groupSessionId: string,
    groupId: string,
    collected: CooldownMessage[],
    selfId: string,
  ): Promise<void> {
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

    const cfg = this.configProvider(groupId);

    const { history } = await this.getGroupHistoryMessages(
      groupId,
      groupSessionId,
      this.ctx,
      cfg.historyCount,
      this.db,
      selfId,
      this.buildHistoryMediaOptions(this.aiInstance, cfg),
    );
    const botNickname =
      cfg.nicknames[0] || this.ctx.pickBot(selfId)?.nickname || "Bot";
    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const { groupName, memberCount } = await this.getGroupInfoData(
      this.ctx,
      groupId,
      selfId,
    );

    const toolCtx = this.buildToolContext({
      ctx: this.ctx,
      event: firstMsg.event,
      groupSessionId,
      groupId,
      userId: targetMessage.userId,
      config: cfg,
      aiService: this.aiService,
      db: this.db,
      botRole,
      humanize: this.humanize,
      targetMessage,
      selfId,
      audioService: this.pluginCtx.audioService,
    });

    const contexts = await this.getHumanizeContexts(
      this.humanize,
      groupSessionId,
      targetMessage.userName,
      history,
      targetMessage.userId,
    );

    const result = await this.runWithRateLimitGuard(
      () =>
        this.runChat(
          this.aiInstance,
          toolCtx,
          history,
          targetMessage,
          {
            config: cfg,
            groupName,
            memberCount,
            botNickname,
            botRole,
            aiService: this.aiService,
            isGroup: true,
            memoryContext: contexts.memoryContext,
            topicContext: contexts.topicContext,
            expressionContext: contexts.expressionContext,
            replyContext: {
              type: "review",
              targetUser: targetMessage.userName,
              targetMessage: targetMessage.content,
            },
            reviewMessages: { contents: mergedContents, userNames, messageIds },
          },
          this.humanize,
          this.skillManager,
          {
            manager: this.groupStructuredHistory,
            ttlMs: cfg.groupStructuredHistoryTtlMs,
            currentUserInputs: collected.map((msg) =>
              this.buildStructuredUserInputFromEvent(
                msg.event,
                msg.content,
                msg.timestamp,
              ),
            ),
          },
        ),
      { userId: targetMessage.userId, groupId, label: "cooldown", skipRetryOnRateLimit: true },
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

  private async processCooldownWithPlanner(
    groupSessionId: string,
    groupId: string,
    collected: CooldownMessage[],
    selfId: string,
  ): Promise<void> {
    const mergedContent = collected.map((m) => m.content).join("\n");
    const firstMsg = collected[0];

    const cfg = this.configProvider(groupId);

    const { history } = await this.getGroupHistoryMessages(
      groupId,
      groupSessionId,
      this.ctx,
      cfg.historyCount,
      this.db,
      selfId,
      this.buildHistoryMediaOptions(this.aiInstance, cfg),
    );
    const botNickname =
      cfg.nicknames[0] || this.ctx.pickBot(selfId)?.nickname || "Bot";

    const planResult = await this.humanize.actionPlanner.plan(
      groupSessionId,
      botNickname,
      history,
      mergedContent,
    );
    if (planResult.action !== "reply") {
      this.ctx.logger.info(
        `[CooldownPlanner] Group ${groupId} planner decided not to reply: ${planResult.reason}`,
      );
      return;
    }

    const targetMessage: TargetMessage = {
      userName: firstMsg.userName,
      userId: firstMsg.userId,
      userRole: firstMsg.event.sender?.role || "member",
      content: mergedContent,
      messageId: firstMsg.messageId,
      timestamp: Date.now(),
    };

    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const toolCtx = this.buildToolContext({
      ctx: this.ctx,
      event: firstMsg.event,
      groupSessionId,
      groupId,
      userId: targetMessage.userId,
      config: cfg,
      aiService: this.aiService,
      db: this.db,
      botRole,
      humanize: this.humanize,
      targetMessage,
      selfId,
      audioService: this.pluginCtx.audioService,
    });
    const { groupName, memberCount } = await this.getGroupInfoData(
      this.ctx,
      groupId,
      selfId,
    );
    const contexts = await this.getHumanizeContexts(
      this.humanize,
      groupSessionId,
      targetMessage.userName,
      history,
      targetMessage.userId,
    );
    const plannerThoughts = `After you spoke, the following messages were sent in the group. Use this context to respond naturally.\nPlanned reason: ${planResult.reason}`;

    const result = await this.runWithRateLimitGuard(
      () =>
        this.runChat(
          this.aiInstance,
          toolCtx,
          history,
          targetMessage,
          {
            config: cfg,
            groupName,
            memberCount,
            botNickname,
            botRole: toolCtx.botRole,
            aiService: this.aiService,
            isGroup: true,
            memoryContext: contexts.memoryContext,
            topicContext: contexts.topicContext,
            expressionContext: contexts.expressionContext,
            plannerThoughts,
            replyContext: {
              type: "comment",
              targetUser: targetMessage.userName,
              targetMessage: targetMessage.content,
            },
            reviewMessages: {
              contents: collected.map((m) => m.content),
              userNames: collected.map((m) => m.userName),
              messageIds: collected.map((m) => m.messageId),
            },
          },
          this.humanize,
          this.skillManager,
          {
            manager: this.groupStructuredHistory,
            ttlMs: cfg.groupStructuredHistoryTtlMs,
            currentUserInputs: collected.map((msg) =>
              this.buildStructuredUserInputFromEvent(
                msg.event,
                msg.content,
                msg.timestamp,
              ),
            ),
          },
        ),
      { userId: targetMessage.userId, groupId, label: "cooldown-planner", skipRetryOnRateLimit: true },
    );
    if (!result) {
      this.ctx.logger.warn(
        `[CooldownPlanner] Group ${groupId} AI request skipped`,
      );
      return;
    }

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
}