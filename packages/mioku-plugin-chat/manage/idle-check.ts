import type { MiokiContext } from "mioki";
import type { AIInstance } from "mioku";
import type { ChatConfig, TargetMessage } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager } from "./group-structured-history";
import type { SessionManager } from "./session";
import type {
  RunRateLimitGuard,
  HistoryMediaOptions,
  GetGroupHistoryMessages,
  GetGroupInfoData,
  SendAIResponse,
  SaveBotMessages,
  RunChat,
  BuildToolContext,
} from "./types";
import { getBotRole, isGroupAllowed } from "../utils";

export class IdleCheckManager {
  private groupLastActivityTime = new Map<string, number>();
  private groupMessageCount = new Map<string, number>();
  private groupLastBotMessageTime = new Map<string, number>();
  private groupMessageCountAfterBot = new Map<string, number>();
  private idleCheckProcessing = new Set<string>();
  private groupLastIdleCheckTime = new Map<string, number>();
  private groupBotsMapping = new Map<string, Set<number>>();
  private intervalHandle: NodeJS.Timeout | null = null;

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
    private runWithRateLimitGuard: RunRateLimitGuard,
    private buildHistoryMediaOptions: (ai: AIInstance, cfg: ChatConfig) => HistoryMediaOptions,
    private getGroupHistoryMessages: GetGroupHistoryMessages,
    private getGroupInfoData: GetGroupInfoData,
    private sendAIResponse: SendAIResponse,
    private saveBotMessages: SaveBotMessages,
    private runChat: RunChat,
    private buildToolContext: BuildToolContext,
    private startCooldownTimer: (groupSessionId: string, groupId: number, selfId: number) => void,
  ) {}

  recordActivity(groupSessionId: string): void {
    this.groupLastActivityTime.set(groupSessionId, Date.now());
    const count = this.groupMessageCount.get(groupSessionId) ?? 0;
    this.groupMessageCount.set(groupSessionId, count + 1);
  }

  recordBotMessages(groupSessionId: string, count: number, selfId: number): void {
    const current = this.groupMessageCountAfterBot.get(groupSessionId) ?? 0;
    this.groupMessageCountAfterBot.set(groupSessionId, current + count);
    let bots = this.groupBotsMapping.get(groupSessionId);
    if (!bots) { bots = new Set<number>(); this.groupBotsMapping.set(groupSessionId, bots); }
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
    this.idleCheckProcessing.clear();
    this.groupLastIdleCheckTime.clear();
    this.groupBotsMapping.clear();
  }

  private async tick(): Promise<void> {
    try {
      const cfg = this.cfg;
      if (!cfg.apiKey || !cfg.planner?.enabled) return;

      const now = Date.now();
      const idleThreshold = cfg.planner.idleThresholdMs ?? 30 * 60_000;
      const messageCountThreshold = cfg.planner.idleMessageCount ?? 100;
      const checkInterval = 60_000;
      const allBotIds = Array.from(this.ctx.bots).map((bot) => bot.uin);
      const idleCheckBotIds = cfg.planner.idleCheckBotIds ?? allBotIds;
      const enabledBotIds = idleCheckBotIds.filter((id) => allBotIds.includes(id));

      for (const [groupSessionId, lastTime] of this.groupLastActivityTime) {
        const lastCheckTime = this.groupLastIdleCheckTime.get(groupSessionId) ?? 0;
        if (now - lastCheckTime < checkInterval) continue;

        const groupId = parseInt(groupSessionId.split(":")[1], 10);
        if (!isGroupAllowed(groupId, cfg)) continue;

        let lastBotTime = this.groupLastBotMessageTime.get(groupSessionId) ?? 0;
        if (lastBotTime === 0) {
          const botMsgs = this.db.getBotMessages(groupId, 1);
          if (botMsgs.length > 0) {
            lastBotTime = botMsgs[botMsgs.length - 1].timestamp;
            this.groupLastBotMessageTime.set(groupSessionId, lastBotTime);
          }
        }

        const lastActivityTime = Math.max(lastTime, lastBotTime);
        if (now - lastActivityTime < idleThreshold) continue;

        const messageCountAfterBot = this.groupMessageCountAfterBot.get(groupSessionId) ?? 0;
        const messageCount = lastBotTime > 0 ? messageCountAfterBot : (this.groupMessageCount.get(groupSessionId) ?? 0);
        if (messageCount < messageCountThreshold) continue;

        const botsInGroup = this.groupBotsMapping.get(groupSessionId);
        if (!botsInGroup || botsInGroup.size === 0) continue;
        const availableBots = Array.from(botsInGroup).filter((id) => enabledBotIds.includes(id));
        if (availableBots.length === 0) continue;

        const selfId = availableBots[Math.floor(Math.random() * availableBots.length)];
        this.idleCheckProcessing.add(groupSessionId);

        try {
          this.ctx.logger.info(`[IdleCheck] group ${groupId} triggers idle detection`);

          const { history } = await this.getGroupHistoryMessages(groupId, groupSessionId, this.ctx, cfg.historyCount, this.db, selfId, this.buildHistoryMediaOptions(this.aiInstance, cfg));
          const botNickname = cfg.nicknames[0] || this.ctx.pickBot(selfId).nickname || "Bot";

          const planResult = await this.humanize.actionPlanner.plan(groupSessionId, botNickname, history, "[Check if you want to answer the call]", true);

          if (planResult.action !== "reply") {
            this.groupMessageCount.set(groupSessionId, 0);
            this.groupMessageCountAfterBot.set(groupSessionId, 0);
            this.groupLastIdleCheckTime.set(groupSessionId, now);
            return;
          }

          const targetMessage: TargetMessage = {
            userName: "system", userId: 0, userRole: "member",
            content: "[No one in the group is talking? I'll answer!]", messageId: 0, timestamp: now,
          };

          const botRole = await getBotRole(groupId, this.ctx, selfId);
          const toolCtx = this.buildToolContext({
            ctx: this.ctx, event: null, groupSessionId, groupId, userId: 0,
            config: cfg, aiService: this.aiService, db: this.db, botRole, humanize: this.humanize, targetMessage, selfId,
          });

          const result = await this.runWithRateLimitGuard(
            () => this.runChat(this.aiInstance, toolCtx, history, targetMessage, {
              config: cfg, botNickname, botRole: toolCtx.botRole, aiService: this.aiService, isGroup: true,
              plannerThoughts: "You stumbled upon some message in this group and decided to reply.\nQuote messages from group friends appropriately (using [reply:message ID] format).\nDon't mention your intentions like \"I'm here to answer\".",
              replyContext: { type: "idle" },
            }, this.humanize, this.skillManager),
            { groupId, label: "idle-check" },
          );
          if (!result) {
            this.groupMessageCount.set(groupSessionId, 0);
            this.groupMessageCountAfterBot.set(groupSessionId, 0);
            this.groupLastIdleCheckTime.set(groupSessionId, now);
            return;
          }

          await this.sendAIResponse({ ctx: this.ctx, groupId, messages: result.messages, config: cfg, sentIndices: toolCtx.sentMessageIndices }, selfId);
          this.saveBotMessages(groupId, groupSessionId, result.messages, now, cfg, this.db, this.ctx, selfId);
          this.groupLastBotMessageTime.set(groupSessionId, now);
          this.groupMessageCountAfterBot.set(groupSessionId, 0);
          this.startCooldownTimer(groupSessionId, groupId, selfId);
          this.ctx.logger.info(`[IdleCheck] group ${groupId} idle reply completed`);
        } catch (err) {
          this.ctx.logger.error(`[IdleCheck] group ${groupId} idle detection failed: ${err}`);
        } finally {
          this.idleCheckProcessing.delete(groupSessionId);
        }
      }
    } catch (err) {}
  }
}