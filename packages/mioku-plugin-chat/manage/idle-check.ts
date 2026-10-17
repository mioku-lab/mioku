import type { MiokuContext } from "mioku";
import type { AIInstance } from "mioku";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine, ChatConfigProvider } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager } from "./group-structured-history";
import type { SessionManager } from "./session";
import type {
  RunRateLimitGuard,
  HistoryMediaOptions,
  GetGroupHistoryMessages,
  GetGroupInfoData,
  RunChat,
  BuildToolContext,
} from "./types";
import type { ChatPluginContext } from "../context";
import { finalizeChatTurn } from "../core/chat-turn";
import { getBotRole, isGroupAllowed } from "../utils";

export class IdleCheckManager {
  private pluginCtx: ChatPluginContext;
  private groupLastActivityTime = new Map<string, number>();
  private groupMessageCount = new Map<string, number>();
  private groupLastBotMessageTime = new Map<string, number>();
  private groupMessageCountAfterBot = new Map<string, number>();
  private groupLastIdleCheckTime = new Map<string, number>();
  private groupBotsMapping = new Map<string, Set<string>>();
  private intervalHandle: NodeJS.Timeout | null = null;

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
  private runWithRateLimitGuard: RunRateLimitGuard;
  private buildHistoryMediaOptions: (ai: AIInstance, cfg: ChatConfig) => HistoryMediaOptions;
  private getGroupHistoryMessages: GetGroupHistoryMessages;
  private getGroupInfoData: GetGroupInfoData;
  private runChat: RunChat;
  private buildToolContext: BuildToolContext;

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
    this.runWithRateLimitGuard = pluginCtx.runWithRateLimitGuard;
    this.buildHistoryMediaOptions = pluginCtx.buildHistoryMediaOptions;
    this.getGroupHistoryMessages = pluginCtx.getGroupHistoryMessages;
    this.getGroupInfoData = pluginCtx.getGroupInfoData;
    this.runChat = pluginCtx.runChat;
    this.buildToolContext = pluginCtx.buildToolContext;
  }

  recordActivity(groupSessionId: string): void {
    this.groupLastActivityTime.set(groupSessionId, Date.now());
    const count = this.groupMessageCount.get(groupSessionId) ?? 0;
    this.groupMessageCount.set(groupSessionId, count + 1);
  }

  recordBotMessages(groupSessionId: string, count: number, selfId: string): void {
    const current = this.groupMessageCountAfterBot.get(groupSessionId) ?? 0;
    this.groupMessageCountAfterBot.set(groupSessionId, current + count);
    let bots = this.groupBotsMapping.get(groupSessionId);
    if (!bots) { bots = new Set<string>(); this.groupBotsMapping.set(groupSessionId, bots); }
    bots.add(selfId);
    this.groupLastBotMessageTime.set(groupSessionId, Date.now());
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(async () => { await this.tick(); }, 60_000);
  }

  stop(): void {
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null; }
  }

  dispose(): void {
    this.stop();
    this.groupLastActivityTime.clear();
    this.groupMessageCount.clear();
    this.groupLastBotMessageTime.clear();
    this.groupMessageCountAfterBot.clear();
    this.groupLastIdleCheckTime.clear();
    this.groupBotsMapping.clear();
  }

  private async tick(): Promise<void> {
    try {
      const baseCfg = this.defaultConfig;
      if (!baseCfg.model && !baseCfg.apiKey) return;

      const now = Date.now();
      const checkInterval = 60_000;
      const allBotIds = Array.from(this.ctx.bots).map((bot) => String(bot.bot_id));

      for (const [groupSessionId, lastTime] of this.groupLastActivityTime) {
        const lastCheckTime =
          this.groupLastIdleCheckTime.get(groupSessionId) ?? 0;
        if (now - lastCheckTime < checkInterval) continue;

        const groupId = String(groupSessionId.split(":")[1] ?? "").trim();
        if (!groupId) continue;
        const cfg = this.configProvider(groupId);
        if (!cfg.planner?.enabled) continue;
        if (!isGroupAllowed(groupId, cfg)) continue;

        const idleThreshold =
          cfg.planner.idleThresholdMs ??
          baseCfg.planner?.idleThresholdMs ??
          30 * 60_000;
        const messageCountThreshold =
          cfg.planner.idleMessageCount ??
          baseCfg.planner?.idleMessageCount ??
          100;
        const idleCheckBotIds =
          cfg.planner.idleCheckBotIds ??
          baseCfg.planner?.idleCheckBotIds ??
          allBotIds;
        const enabledBotIds = idleCheckBotIds.filter((id: string) =>
          allBotIds.includes(id),
        );

        let lastBotTime =
          this.groupLastBotMessageTime.get(groupSessionId) ?? 0;
        if (lastBotTime === 0) {
          const botMsgs = this.db.getBotMessages(groupId, 1);
          if (botMsgs.length > 0) {
            lastBotTime = botMsgs[botMsgs.length - 1].timestamp;
            this.groupLastBotMessageTime.set(groupSessionId, lastBotTime);
          }
        }

        const lastActivityTime = Math.max(lastTime, lastBotTime);
        if (now - lastActivityTime < idleThreshold) continue;

        const messageCountAfterBot =
          this.groupMessageCountAfterBot.get(groupSessionId) ?? 0;
        const messageCount =
          lastBotTime > 0
            ? messageCountAfterBot
            : (this.groupMessageCount.get(groupSessionId) ?? 0);
        if (messageCount < messageCountThreshold) continue;

        const botsInGroup = this.groupBotsMapping.get(groupSessionId);
        if (!botsInGroup || botsInGroup.size === 0) continue;
        const availableBots = Array.from(botsInGroup).filter((id) =>
          enabledBotIds.includes(id),
        );
        if (availableBots.length === 0) continue;

        const selfId =
          availableBots[Math.floor(Math.random() * availableBots.length)];
        this.groupLastIdleCheckTime.set(groupSessionId, now);
        void this.pluginCtx.sessionTurnScheduler
          .run(
            groupSessionId,
            "idle-check",
            () =>
              this.processIdleCheckTurn(
                groupSessionId,
                groupId,
                selfId,
                cfg,
                lastActivityTime,
                now,
              ),
            { dedupeKey: "idle-check" },
          )
          .catch((err) =>
            this.ctx.logger.error(
              `[IdleCheck] group ${groupId} idle detection failed: ${err}`,
            ),
          );
      }
    } catch (err) {
      this.ctx.logger.error(`[IdleCheck] tick failed: ${err}`);
    }
  }

  private async processIdleCheckTurn(
    groupSessionId: string,
    groupId: string,
    selfId: string,
    cfg: ChatConfig,
    scheduledLastActivity: number,
    scheduledAt: number,
  ): Promise<void> {
    const latestActivity = Math.max(
      this.groupLastActivityTime.get(groupSessionId) ?? 0,
      this.groupLastBotMessageTime.get(groupSessionId) ?? 0,
    );
    if (latestActivity > scheduledLastActivity) return;

    this.ctx.logger.info(`[IdleCheck] group ${groupId} triggers idle detection`);
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
      "[Check if you want to answer the call]",
      true,
    );

    if (planResult.action !== "reply") {
      this.groupMessageCount.set(groupSessionId, 0);
      this.groupMessageCountAfterBot.set(groupSessionId, 0);
      this.groupLastIdleCheckTime.set(groupSessionId, scheduledAt);
      return;
    }

    const targetMessage: TargetMessage = {
      userName: "system",
      userId: "",
      userRole: "member",
      content: "[No one in the group is talking? I'll answer!]",
      messageId: "",
      timestamp: scheduledAt,
    };
    const botRole = await getBotRole(groupId, this.ctx, selfId);
    const toolCtx = this.buildToolContext({
      ctx: this.ctx,
      event: null,
      groupSessionId,
      groupId,
      userId: "",
      config: cfg,
      aiService: this.aiService,
      db: this.db,
      botRole,
      humanize: this.humanize,
      targetMessage,
      selfId,
      audioService: this.pluginCtx.audioService,
    });

    const result = await this.runWithRateLimitGuard(
      () =>
        this.runChat(
          this.aiInstance,
          toolCtx,
          history,
          targetMessage,
          {
            config: cfg,
            botNickname,
            botRole: toolCtx.botRole,
            aiService: this.aiService,
            isGroup: true,
            plannerThoughts:
              'You stumbled upon some message in this group and decided to reply.\nQuote messages from group friends appropriately (using [reply:message ID] format).\nDon\'t mention your intentions like "I\'m here to answer".',
            replyContext: { type: "idle" },
          },
          this.humanize,
          this.skillManager,
        ),
      { groupId, label: "idle-check", skipRetryOnRateLimit: true },
    );
    if (!result) {
      this.groupMessageCount.set(groupSessionId, 0);
      this.groupMessageCountAfterBot.set(groupSessionId, 0);
      this.groupLastIdleCheckTime.set(groupSessionId, scheduledAt);
      return;
    }

    await finalizeChatTurn(this.pluginCtx, {
      event: null,
      cfg,
      result,
      groupId,
      groupSessionId,
      userId: "",
      selfId,
      toolCtx,
      send: true,
      isLive: true,
    });
    this.groupLastBotMessageTime.set(groupSessionId, Date.now());
    this.groupMessageCountAfterBot.set(groupSessionId, 0);
    this.ctx.logger.info(`[IdleCheck] group ${groupId} idle reply completed`);
  }
}