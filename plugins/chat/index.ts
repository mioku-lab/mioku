import type { AIInstance, AIService } from "../../src/services/ai/types";
import type { ConfigService } from "../../src/services/config/tpyes";
import type { ScreenshotService } from "../../src/services/screenshot/types";
import { definePlugin, MiokiContext } from "mioki";
import type { ChatConfig, ChatMessage, TargetMessage } from "./types";
import { initDatabase } from "./db";
import { SessionManager } from "./manage/session";
import { RateLimiter } from "./manage/rate-limiter";
import { runChat } from "./core/chat-engine";
import { HumanizeEngine } from "./humanize";
import { SkillSessionManager } from "./manage/skill-session";
import {
  getBotRole,
  getGroupHistory,
  getQuotedContent,
  isGroupAllowed,
  isQuotingBot,
  shouldTrigger,
} from "./utils";
import { BASE_CONFIG } from "./configs/base";
import { SETTINGS_CONFIG } from "./configs/settings";
import { PERSONALIZATION_CONFIG } from "./configs/personalization";
import { MessageQueueManager } from "./utils/queue";
import {
  buildToolContext,
  getGroupHistoryMessages,
  getGroupInfoData,
  getHumanizeContexts,
  sendAIResponse,
  sendMessage,
  saveBotMessages,
  sendEmoji,
} from "./core/base";
import {
  summarizeGroupNotice,
  summarizeHistoryCard,
  summarizeHistoryForward,
  summarizeHistoryVideo,
  type HistoryMediaProcessingOptions,
} from "./core/media/history-media";
import { CooldownManager } from "./manage/cooldown";
import { IdleCheckManager } from "./manage/idle-check";
import { QueueProcessor } from "./manage/queue-processor";
import {
  GroupStructuredHistoryManager,
  type StructuredUserInput,
} from "./manage/group-structured-history";
import type {
  RunRateLimitGuard,
  HistoryMediaOptions,
  GetGroupHistoryMessages,
  SendAIResponse,
  SaveBotMessages,
  RunChat,
  BuildToolContext,
} from "./manage/types";
import type { ChatPluginContext, ChatRuntime } from "./context";

function buildStructuredUserInputFromEvent(
  event: any,
  content: string,
  fallbackTimestamp: number = Date.now(),
): StructuredUserInput {
  return {
    userName:
      event?.sender?.card ||
      event?.sender?.nickname ||
      String(event?.user_id || event?.sender?.user_id || 0),
    userId: event?.user_id || event?.sender?.user_id || 0,
    userRole: event?.sender?.role || "member",
    userTitle: event?.sender?.title,
    content,
    messageId: event?.message_id,
    timestamp:
      typeof event?.time === "number" ? event.time * 1000 : fallbackTimestamp,
  };
}

function buildStructuredUserInputFromTarget(
  targetMessage: TargetMessage,
): StructuredUserInput {
  return {
    userName: targetMessage.userName,
    userId: targetMessage.userId,
    userRole: targetMessage.userRole,
    userTitle: targetMessage.userTitle,
    content: targetMessage.content,
    messageId: targetMessage.messageId,
    timestamp: targetMessage.timestamp,
  };
}

function buildHistoryMediaOptions(ai: AIInstance, config: ChatConfig) {
  return {
    ai,
    workingModel: config.workingModel || config.model,
    multimodalWorkingModel: config.multimodalWorkingModel || config.model,
  };
}

function normalizeIdList(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => Math.floor(Number(item)))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
}

function getSegmentUrl(seg: {
  url?: string;
  data?: { url?: string };
}): string | null {
  const url = seg?.url || seg?.data?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function getSegmentSourceCandidates(seg: {
  file?: string;
  data?: { file?: string; path?: string; url?: string };
  path?: string;
  url?: string;
}): string[] {
  return Array.from(
    new Set(
      [
        seg?.file,
        seg?.data?.file,
        seg?.path,
        seg?.data?.path,
        seg?.url,
        seg?.data?.url,
      ]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean),
    ),
  );
}

async function getVideoSourceCandidatesFromMessage(
  bot: {
    api(action: string, params?: Record<string, unknown>): Promise<unknown>;
  },
  messageId: number | string | undefined,
): Promise<string[]> {
  if (messageId == null) return [];
  const result = (await bot.api("get_msg", { message_id: messageId })) as {
    message?: unknown[];
    data?: { message?: unknown[] };
  };
  const segments = result?.message || result?.data?.message || [];
  if (!Array.isArray(segments)) return [];
  const candidates: string[] = [];
  for (const seg of segments as { type?: string }[]) {
    if (seg?.type !== "video") continue;
    candidates.push(
      ...getSegmentSourceCandidates(
        seg as Parameters<typeof getSegmentSourceCandidates>[0],
      ),
    );
  }
  return candidates;
}

function getForwardId(seg: {
  id?: unknown;
  data?: { id?: unknown };
}): string | null {
  return String(seg?.id || seg?.data?.id || "");
}

function getCardData(seg: { data?: unknown }): string | null {
  const data = seg?.data;
  if (!data) return null;
  return typeof data === "string" ? data : JSON.stringify(data);
}

function isMediaAnalysisBlocked(config: ChatConfig, userId: number): boolean {
  return Boolean(config.mediaAnalysisBlacklistUsers?.includes(userId));
}

function buildHistoryMediaProcessingOptions(
  ai: AIInstance,
  config: ChatConfig,
  db: {
    getMediaSummary(key: string): import("./types").MediaSummaryRecord | null;
    saveMediaSummary(summary: import("./types").MediaSummaryRecord): void;
  },
  bot: {
    api<T = unknown>(
      action: string,
      params?: Record<string, unknown>,
    ): Promise<T>;
  },
  groupId: number,
  log: HistoryMediaProcessingOptions["logger"],
  runAIRequest?: <T>(request: () => Promise<T>) => Promise<T | null>,
): HistoryMediaProcessingOptions {
  return {
    ...buildHistoryMediaOptions(ai, config),
    db,
    logger: log,
    bot,
    groupId,
    runAIRequest,
  };
}

const chatPlugin = definePlugin({
  name: "chat",
  version: "1.0.0",
  description: "AI 智能聊天插件",

  async setup(ctx: MiokiContext) {
    ctx.logger.info("聊天插件正在初始化...");

    const aiService = ctx.services?.ai as AIService | undefined;
    const configService = ctx.services?.config as ConfigService | undefined;
    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;
    let warnedMarkdownScreenshotUnavailable = false;

    if (configService) {
      await configService.registerConfig("chat", "base", BASE_CONFIG);
      await configService.registerConfig("chat", "settings", SETTINGS_CONFIG);
      await configService.registerConfig(
        "chat",
        "personalization",
        PERSONALIZATION_CONFIG,
      );
    }

    const getConfig = async (): Promise<ChatConfig> => {
      if (!configService) {
        return {
          ...BASE_CONFIG,
          ...SETTINGS_CONFIG,
          ...PERSONALIZATION_CONFIG,
        } as ChatConfig;
      }
      const base = await configService.getConfig("chat", "base");
      const settings = await configService.getConfig("chat", "settings");
      const personalization = await configService.getConfig(
        "chat",
        "personalization",
      );
      const merged = {
        ...BASE_CONFIG,
        ...SETTINGS_CONFIG,
        ...PERSONALIZATION_CONFIG,
        ...base,
        ...settings,
        ...personalization,
      } as any;

      if (typeof merged.stream !== "boolean") merged.stream = true;
      if (typeof merged.enableMarkdownScreenshot !== "boolean")
        merged.enableMarkdownScreenshot = true;
      if (!screenshotService && merged.enableMarkdownScreenshot) {
        merged.enableMarkdownScreenshot = false;
        if (!warnedMarkdownScreenshotUnavailable) {
          ctx.logger.warn(
            "聊天插件未加载 screenshot 服务，Markdown 截图渲染已自动关闭",
          );
          warnedMarkdownScreenshotUnavailable = true;
        }
      }
      merged.whitelistGroups = normalizeIdList(merged.whitelistGroups);
      merged.blacklistGroups = normalizeIdList(merged.blacklistGroups);
      merged.mediaAnalysisBlacklistUsers = normalizeIdList(
        merged.mediaAnalysisBlacklistUsers ??
          merged.imageAnalysisBlacklistUsers,
      );
      delete merged.imageAnalysisBlacklistUsers;
      return merged as ChatConfig;
    };

    const config = await getConfig();

    if (!config.apiKey) {
      ctx.logger.warn(
        "聊天插件未配置 API Key，请在 config/chat/base.json 中配置",
      );
      return;
    }

    const db = await initDatabase();
    const sessionManager = new SessionManager(db, config.maxSessions);
    const queueManager = new MessageQueueManager();
    const rateLimiter = new RateLimiter({
      dynamicDelay: config.dynamicDelay,
      aiRequestLimits: config.aiRequestLimits,
    });
    const skillManager = new SkillSessionManager();

    rateLimiter.setQueueLengthGetter((groupId: number) => {
      return queueManager.getQueueLength(`group:${groupId}`);
    });

    if (!aiService) {
      ctx.logger.error("聊天插件需要 AI 服务，但 AI 服务不可用");
      return;
    }

    const aiInstance = await aiService.create({
      name: "default",
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      modelType: config.isMultimodal ? "multimodal" : "text",
    });
    aiService.setDefault("default");

    const humanize = new HumanizeEngine(aiInstance, config, db);
    await humanize.init();

    const pokeCooldowns = new Map<number, number>();
    const POKE_COOLDOWN_MS = 10 * 60_000;
    const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
    const RATE_LIMIT_MAX_RETRIES = 2;
    let rateLimitBlockedUntil = 0;
    const processingSet = new Set<string>();
    const groupStructuredHistory = new GroupStructuredHistoryManager();

    function isRateLimitError(err: unknown): boolean {
      return (
        String(err).toLowerCase().includes("429") ||
        String(err).toLowerCase().includes("rate limit")
      );
    }

    function isRateLimitBlocked(): boolean {
      return Date.now() < rateLimitBlockedUntil;
    }

    function markRateLimitBlocked(): void {
      rateLimitBlockedUntil = Date.now() + RATE_LIMIT_RETRY_DELAY_MS;
    }

    async function runWithRateLimitGuard<T>(
      request: () => Promise<T>,
      options?: { userId?: number; groupId?: number; label?: string },
    ): Promise<T | null> {
      if (isRateLimitBlocked()) {
        ctx.logger.warn(
          `[Chat] AI request skipped due to rate limit block${options?.label ? ` (${options.label})` : ""}`,
        );
        return null;
      }
      if (!rateLimiter.canRunAIRequest(options?.userId, options?.groupId)) {
        ctx.logger.warn(
          `[Chat] AI request skipped due to RPM limit${options?.label ? ` (${options.label})` : ""}`,
        );
        return null;
      }
      rateLimiter.recordAIRequest(options?.userId, options?.groupId);

      let retries = 0;
      while (true) {
        try {
          const result = await request();
          rateLimitBlockedUntil = 0;
          return result;
        } catch (err) {
          if (!isRateLimitError(err)) throw err;
          markRateLimitBlocked();
          if (retries >= RATE_LIMIT_MAX_RETRIES) throw err;
          retries += 1;
          ctx.logger.warn(
            `[Chat] Rate limit hit, waiting ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS),
          );
          if (isRateLimitBlocked()) rateLimitBlockedUntil = 0;
        }
      }
    }

    let cooldownManager!: CooldownManager;
    let idleCheckManager!: IdleCheckManager;
    let queueProcessor!: QueueProcessor;

    const makeStartCooldownTimer =
      () => (groupSessionId: string, groupId: number, selfId: number) => {
        cooldownManager.startCooldownTimer(groupSessionId, groupId, selfId);
      };

    idleCheckManager = new IdleCheckManager(
      ctx,
      config,
      db,
      humanize,
      aiInstance,
      aiService,
      skillManager,
      groupStructuredHistory,
      sessionManager,
      runWithRateLimitGuard,
      buildHistoryMediaOptions,
      getGroupHistoryMessages,
      getGroupInfoData,
      sendAIResponse,
      saveBotMessages,
      runChat,
      buildToolContext,
      makeStartCooldownTimer(),
    );

    cooldownManager = new CooldownManager(
      ctx,
      config,
      db,
      humanize,
      aiInstance,
      aiService,
      skillManager,
      groupStructuredHistory,
      sessionManager,
      rateLimiter,
      idleCheckManager,
      runWithRateLimitGuard,
      buildHistoryMediaOptions,
      getGroupHistoryMessages,
      getGroupInfoData,
      getHumanizeContexts,
      sendAIResponse,
      saveBotMessages,
      sendEmoji,
      runChat,
      buildToolContext,
      buildStructuredUserInputFromEvent,
    );

    queueProcessor = new QueueProcessor(
      ctx,
      config,
      db,
      humanize,
      aiInstance,
      aiService,
      skillManager,
      groupStructuredHistory,
      sessionManager,
      rateLimiter,
      queueManager,
      runWithRateLimitGuard,
      buildHistoryMediaOptions,
      getGroupHistoryMessages,
      getGroupInfoData,
      getHumanizeContexts,
      sendAIResponse,
      saveBotMessages,
      sendEmoji,
      runChat,
      buildToolContext,
      buildStructuredUserInputFromEvent,
      makeStartCooldownTimer(),
    );

    const cleanupInterval = setInterval(
      () => skillManager.cleanup(),
      10 * 60_000,
    );
    idleCheckManager.start();

    // Create plugin context for passing to functions
    const pluginCtx: ChatPluginContext = {
      ctx,
      config,
      db,
      aiInstance,
      aiService,
      humanize,
      sessionManager,
      skillManager,
      rateLimiter,
      queueManager,
      groupStructuredHistory,
      cooldownManager,
      idleCheckManager,
      queueProcessor,
      runWithRateLimitGuard,
      buildHistoryMediaOptions,
      getGroupHistoryMessages,
      getGroupInfoData,
      getHumanizeContexts,
      sendAIResponse,
      sendMessage,
      saveBotMessages,
      sendEmoji,
      buildToolContext,
      buildStructuredUserInputFromTarget,
      runChat,
    };

    const runtime: ChatRuntime = {
      isRateLimitBlocked,
      processingSet,
    };

    // ==================== 消息处理 ====================
    ctx.handle("message", async (e: any) => {
      const cfg = await getConfig();
      if (!cfg.apiKey) return;

      const text = ctx.text(e) || "";
      const isGroup = e.message_type === "group";
      const groupId: number | undefined = isGroup ? e.group_id : undefined;
      const userId: number = e.user_id || e.sender?.user_id;

      if (userId === e.self_id) return;

      // 命令处理
      if (text.startsWith("/空闲检查 ")) {
        await handleIdleCheckDebug(
          ctx,
          e,
          cfg,
          aiInstance,
          db,
          humanize,
          skillManager,
          runWithRateLimitGuard,
          getGroupHistoryMessages,
          buildHistoryMediaOptions,
          runChat,
          buildToolContext,
          sendAIResponse,
          saveBotMessages,
        );
        return;
      }

      if (text === "/重置会话") {
        if (groupId) {
          sessionManager.resetBotMessages(`group:${groupId}`);
          groupStructuredHistory.clear(`group:${groupId}`);
          await e.reply("已清除本群会话中 AI 发送的消息~");
        } else {
          sessionManager.resetBotMessages(`personal:${userId}`);
          groupStructuredHistory.clear(`personal:${userId}`);
          await e.reply("已清除你的个人会话中 AI 发送的消息~");
        }
        return;
      }

      if (groupId && !isGroupAllowed(groupId, cfg)) return;

      // 媒体分析
      if (
        isGroup &&
        groupId &&
        e.message &&
        !isMediaAnalysisBlocked(cfg, userId)
      ) {
        const ai = aiService!.getDefault();
        const bot = ctx.pickBot(e.self_id) as any;
        const mediaOptions = ai
          ? buildHistoryMediaProcessingOptions(
              ai,
              cfg,
              db,
              bot,
              groupId,
              {
                info: (m) => ctx.logger.info(m),
                warn: (m) => ctx.logger.warn(m),
                error: (m) => ctx.logger.error(m),
              },
              (request) =>
                runWithRateLimitGuard(request, {
                  userId,
                  groupId,
                  label: "history-media",
                }),
            )
          : undefined;

        if (ai && cfg.isMultimodal) {
          const { processImage } = await import("./core/media/image-analyzer");
          for (const seg of e.message) {
            if (seg.type === "image") {
              const imageUrl = getSegmentUrl(seg);
              if (imageUrl) {
                processImage(ai, imageUrl, cfg.multimodalWorkingModel, db, {
                  runAIRequest: (request) =>
                    runWithRateLimitGuard(request, {
                      userId,
                      groupId,
                      label: "image-analysis",
                    }),
                }).catch((err) =>
                  ctx.logger.error(`[image-analyzer] Failed: ${err}`),
                );
              }
            } else if (seg.type === "video" && mediaOptions) {
              const videoSources = [
                ...getSegmentSourceCandidates(seg),
                ...(await getVideoSourceCandidatesFromMessage(
                  bot,
                  e.message_id,
                ).catch(() => [])),
              ];
              if (videoSources.length > 0) {
                summarizeHistoryVideo(videoSources, mediaOptions).catch((err) =>
                  ctx.logger.error(
                    `[history-media] Failed to process video: ${err}`,
                  ),
                );
              }
            }
          }
        }

        if (mediaOptions) {
          for (const seg of e.message) {
            if (seg.type === "forward") {
              const forwardId = getForwardId(seg);
              if (forwardId)
                summarizeHistoryForward(forwardId, mediaOptions).catch((err) =>
                  ctx.logger.error(
                    `[history-media] Failed to process forward: ${err}`,
                  ),
                );
            } else if (["xml", "json", "lightapp", "ark"].includes(seg.type)) {
              const cardData = getCardData(seg);
              if (cardData)
                summarizeHistoryCard(cardData, mediaOptions).catch((err) =>
                  ctx.logger.error(
                    `[history-media] Failed to process card: ${err}`,
                  ),
                );
            }
          }
          if (e.sub_type === "notice") {
            summarizeGroupNotice(e, mediaOptions)
              .then((noticeMessage) => {
                if (!noticeMessage) return;
                db.saveMessage({
                  sessionId: `group:${groupId}`,
                  role: "user",
                  content: noticeMessage.content,
                  userId: noticeMessage.userId,
                  userName: noticeMessage.userName,
                  userRole: noticeMessage.userRole,
                  groupId,
                  groupName: e.group_name,
                  timestamp: noticeMessage.timestamp,
                  messageId: noticeMessage.messageId,
                });
              })
              .catch((err) =>
                ctx.logger.error(
                  `[history-media] Failed to process group notice: ${err}`,
                ),
              );
          }
        }
      }

      const atBot = shouldTrigger(e, text, cfg, ctx);
      const quotedBot = isGroup ? await isQuotingBot(e, ctx) : null;
      const mentionedNickname =
        cfg.nicknames.length > 0 &&
        cfg.nicknames.some((n) => text.toLowerCase().includes(n.toLowerCase()));

      const groupSessionId = groupId ? `group:${groupId}` : undefined;

      // 记录群活动
      if (isGroup && groupId && groupSessionId) {
        idleCheckManager.recordActivity(groupSessionId);

        if (cooldownManager.isInCooldown(groupSessionId)) {
          cooldownManager.collectMessage(
            groupSessionId,
            groupId,
            e,
            text,
            atBot,
          );
          return;
        }

        if (queueProcessor.isInDynamicDelay(groupSessionId)) {
          if (atBot && !isRateLimitBlocked()) {
            rateLimiter.recordInteraction(groupId, userId);
            queueProcessor.collectDynamicDelayMessage(groupSessionId, e, text);
          }
          return;
        }
      }

      // 检查是否在处理中
      if (isGroup && groupId && groupSessionId) {
        if (processingSet.has(groupSessionId)) {
          if ((atBot || mentionedNickname) && !isRateLimitBlocked()) {
            queueManager.enqueue(groupSessionId, e, cfg);
            rateLimiter.recordInteraction(groupId, userId);
          }
          return;
        }
        processingSet.add(groupSessionId);
      } else {
        const triggerKey = `personal:${userId}`;
        if (processingSet.has(triggerKey)) return;
        processingSet.add(triggerKey);
      }

      try {
        if (atBot) {
          if (!rateLimiter.canProcess(userId, groupId, text)) return;

          if (
            isGroup &&
            groupId &&
            groupSessionId &&
            cfg.dynamicDelay?.enabled
          ) {
            rateLimiter.recordInteraction(groupId, userId);
            const delayInfo = rateLimiter.getDelayInfo(groupId);
            if (delayInfo.shouldDelay) {
              rateLimiter.record(userId, groupId, text);
              queueProcessor.collectDynamicDelayMessage(
                groupSessionId,
                e,
                text,
              );
              queueProcessor.startDynamicDelayTimer(
                groupSessionId,
                groupId,
                delayInfo.delayMs,
                e.self_id,
              );
              return;
            }
          }

          rateLimiter.record(userId, groupId, text);
          await processChat(e, pluginCtx, runtime);
          return;
        }

        if (quotedBot || mentionedNickname) {
          const { history } = await getGroupHistoryMessages(
            groupId!,
            groupSessionId!,
            ctx,
            cfg.historyCount,
            db,
            e.self_id,
            pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
          );
          const botNickname =
            cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";
          const planResult = await humanize.actionPlanner.plan(
            groupSessionId!,
            botNickname,
            history,
            text,
          );
          if (planResult.action !== "reply") return;
          if (!rateLimiter.canProcess(userId, groupId, text)) return;
          rateLimiter.record(userId, groupId, text);
          await processChat(e, pluginCtx, runtime);
          return;
        }
      } finally {
        if (isGroup && groupId && groupSessionId) {
          processingSet.delete(groupSessionId);
          await queueProcessor.processQueuedMessages(groupSessionId, e.self_id);
        } else {
          processingSet.delete(`personal:${userId}`);
        }
      }
    });

    // ==================== 戳一戳处理 ====================
    ctx.handle("notice.group.poke" as any, async (e: any) => {
      if (e.target_id !== e.self_id) return;
      const cfg = await getConfig();
      if (!cfg.apiKey) return;
      const groupId = e.group_id;
      if (!groupId || !isGroupAllowed(groupId, cfg)) return;

      const lastPoke = pokeCooldowns.get(groupId) ?? 0;
      if (Date.now() - lastPoke < POKE_COOLDOWN_MS) return;
      pokeCooldowns.set(groupId, Date.now());

      const groupSessionId = `group:${groupId}`;
      if (isRateLimitBlocked()) return;

      if (processingSet.has(groupSessionId)) {
        if (!isRateLimitBlocked()) queueManager.enqueue(groupSessionId, e, cfg);
        return;
      }

      processingSet.add(groupSessionId);
      sessionManager.getOrCreate(groupSessionId, "group", groupId);

      try {
        const userId = e.user_id || e.operator_id;
        const botRole = await getBotRole(groupId, ctx, e.self_id);
        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";

        let senderName = String(userId);
        try {
          const memberInfo = await ctx
            .pickBot(e.self_id)
            .getGroupMemberInfo(groupId, userId);
          senderName =
            (memberInfo as any).card ||
            (memberInfo as any).nickname ||
            String(userId);
        } catch {}

        const targetMessage: TargetMessage = {
          userName: senderName,
          userId,
          userRole: "member",
          content: `[${senderName} poked you]`,
          timestamp: Date.now(),
        };

        const { history } = await getGroupHistoryMessages(
          groupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          db,
          e.self_id,
          pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
        );
        const { groupName, memberCount } = await getGroupInfoData(
          ctx,
          groupId,
          e.self_id,
        );

        const toolCtx = buildToolContext({
          ctx,
          event: e,
          groupSessionId,
          groupId,
          userId,
          config: cfg,
          aiService: aiService!,
          db,
          botRole,
          humanize,
          targetMessage,
          selfId: e.self_id,
        });

        const result = await runWithRateLimitGuard(
          () =>
            runChat(
              aiInstance,
              toolCtx,
              history,
              targetMessage,
              {
                config: cfg,
                groupName,
                memberCount,
                botNickname,
                botRole,
                aiService: aiService!,
                isGroup: true,
                replyContext: {
                  type: "poked",
                  targetUser: targetMessage.userName,
                  targetMessage: targetMessage.content,
                },
              },
              humanize,
              skillManager,
              {
                manager: groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: [
                  buildStructuredUserInputFromTarget(targetMessage),
                ],
              },
            ),
          { userId, groupId, label: "poke" },
        );
        if (!result) return;

        await sendAIResponse(
          {
            ctx,
            groupId,
            messages: result.messages,
            config: cfg,
            sentIndices: toolCtx.sentMessageIndices,
            typoGenerator: humanize.typoGenerator,
          },
          e.self_id,
        );

        const now = Date.now();
        saveBotMessages(
          groupId,
          groupSessionId,
          result.messages,
          now,
          cfg,
          db,
          ctx,
          e.self_id,
        );
        idleCheckManager.recordBotMessages(
          groupSessionId,
          result.messages.length,
          e.self_id,
        );

        await sendEmoji(ctx, groupId, result.emojiPath, e.self_id);
        sessionManager.touch(groupSessionId);
      } catch (err) {
        ctx.logger.error(`Poke processing failed: ${err}`);
      } finally {
        processingSet.delete(groupSessionId);
      }
    });

    ctx.logger.info("聊天插件加载成功");

    return () => {
      db.close();
      rateLimiter.dispose();
      clearInterval(cleanupInterval);
      cooldownManager.dispose();
      idleCheckManager.dispose();
      queueProcessor.dispose();
      processingSet.clear();
      pokeCooldowns.clear();
      ctx.logger.info("聊天插件已卸载");
    };
  },
});

async function handleIdleCheckDebug(
  ctx: MiokiContext,
  e: any,
  cfg: ChatConfig,
  aiInstance: AIInstance,
  db: import("./db").ChatDatabase,
  humanize: HumanizeEngine,
  skillManager: SkillSessionManager,
  runWithRateLimitGuard: RunRateLimitGuard,
  getGroupHistoryMessages: GetGroupHistoryMessages,
  buildHistoryMediaOptions: (
    ai: AIInstance,
    cfg: ChatConfig,
  ) => HistoryMediaOptions,
  runChat: RunChat,
  buildToolContext: BuildToolContext,
  sendAIResponse: SendAIResponse,
  saveBotMessages: SaveBotMessages,
) {
  const isOwner = ctx.isOwner?.(e) ?? false;
  if (!isOwner) {
    await e.reply("只有主人才能使用这个指令~");
    return;
  }
  const groupIdStr = e.message[0]?.text?.replace("/空闲检查", "")?.trim() || "";
  const targetGroupId = parseInt(groupIdStr, 10);
  if (!targetGroupId) {
    await e.reply("请指定群号，如：/空闲检查 123456");
    return;
  }

  const groupSessionId = `group:${targetGroupId}`;
  try {
    const now = Date.now();
    const botNickname =
      cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";
    ctx.logger.info(`[Debug] Manual idle check: group ${targetGroupId}`);

    const { history } = await getGroupHistoryMessages(
      targetGroupId,
      groupSessionId,
      ctx,
      cfg.historyCount,
      db,
      e.self_id,
      buildHistoryMediaOptions(aiInstance, cfg),
    );
    const planResult = await humanize.actionPlanner.plan(
      groupSessionId,
      botNickname,
      history,
      "[Check if you want to answer the call]",
      true,
    );

    if (planResult.action !== "reply") {
      await e.reply(
        `[空闲检测] 群 ${targetGroupId}\n决定: ${planResult.action}\n原因: ${planResult.reason}`,
      );
      return;
    }

    const targetMessage: TargetMessage = {
      userName: "系统",
      userId: 0,
      userRole: "member",
      content: "[No one in the group is talking? I'll answer!]",
      messageId: 0,
      timestamp: now,
    };
    const botRole = await getBotRole(targetGroupId, ctx, e.self_id);
    const toolCtx = buildToolContext({
      ctx,
      event: null,
      groupSessionId,
      groupId: targetGroupId,
      userId: 0,
      config: cfg,
      aiService: ctx.services!.ai as AIService,
      db,
      botRole,
      humanize,
      targetMessage,
      selfId: e.self_id,
    });

    const result = await runWithRateLimitGuard(
      () =>
        runChat(
          aiInstance,
          toolCtx,
          history,
          targetMessage,
          {
            config: cfg,
            botNickname,
            botRole: toolCtx.botRole,
            aiService: ctx.services!.ai as AIService,
            isGroup: true,
            plannerThoughts: `You stumbled upon some message in this group and decided to reply.\nQuote messages from group friends appropriately (using [[[reply:message ID]]] format).\nDon't mention your intentions like "I'm here to answer".`,
            replyContext: { type: "idle" },
          },
          humanize,
          skillManager,
        ),
      { groupId: targetGroupId, label: "idle-check" },
    );
    if (!result) {
      await e.reply(`[空闲检测] 群 ${targetGroupId} 因限流被跳过`);
      return;
    }

    await sendAIResponse(
      {
        ctx,
        groupId: targetGroupId,
        messages: result.messages,
        config: cfg,
        sentIndices: toolCtx.sentMessageIndices,
        typoGenerator: humanize.typoGenerator,
      },
      e.self_id,
    );
    const now2 = Date.now();
    saveBotMessages(
      targetGroupId,
      groupSessionId,
      result.messages,
      now2,
      cfg,
      db,
      ctx,
      e.self_id,
    );
    await e.reply(
      `[空闲检测] 群 ${targetGroupId} 已发送回复: ${planResult.reason}`,
    );
  } catch (err) {
    ctx.logger.error(`[Debug] Idle check failed: ${err}`);
    await e.reply(`[空闲检测] 失败: ${err}`);
  }
}

async function processChat(
  e: any,
  pluginCtx: ChatPluginContext,
  runtime: ChatRuntime,
) {
  const { ctx, config: cfg } = pluginCtx;
  const isGroup = e.message_type === "group";
  const groupId: number | undefined = isGroup ? e.group_id : undefined;
  const userId: number = e.user_id || e.sender?.user_id;
  const selfId = e.self_id;

  const personalSessionId = `personal:${userId}`;
  const groupSessionId = groupId ? `group:${groupId}` : personalSessionId;

  if (runtime.isRateLimitBlocked()) {
    if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
    return;
  }

  try {
    pluginCtx.sessionManager.getOrCreate(
      groupSessionId,
      groupId ? "group" : "personal",
      groupId ?? userId,
    );
    if (groupId)
      pluginCtx.sessionManager.getOrCreate(
        personalSessionId,
        "personal",
        userId,
      );

    const quotedInfo = await getQuotedContent(e, ctx);
    const imageUrls: string[] = [];

    if (e.message) {
      for (const seg of e.message) {
        if (seg.type === "image" && (seg.url || seg.data?.url))
          imageUrls.push(seg.url || seg.data.url);
      }
    }
    if (quotedInfo?.imageUrl) imageUrls.push(quotedInfo.imageUrl);

    let messageContent = ctx.text(e) || "";
    let extraContext = "";
    if (quotedInfo) {
      const parts = [
        `[Quoted message #${quotedInfo.messageId} from ${quotedInfo.senderName}: ${quotedInfo.content}]`,
      ];
      if (quotedInfo.imageUrl) parts.push("[Quoted message contains an image]");
      extraContext = parts.join(" ");
    }
    if (extraContext) messageContent = extraContext + " " + messageContent;

    const userMsg = {
      sessionId: groupSessionId,
      role: "user" as const,
      content: messageContent,
      userId,
      userName: e.sender?.card || e.sender?.nickname || String(userId),
      userRole: e.sender?.role || "member",
      userTitle: (e.sender as any)?.title || undefined,
      groupId,
      groupName: isGroup ? e.group_name : undefined,
      timestamp: Date.now(),
      messageId: e.message_id,
    };
    pluginCtx.db.saveMessage(userMsg);

    pluginCtx.humanize.expressionLearner.onMessage(userMsg).then();
    pluginCtx.humanize.topicTracker.onMessage(groupSessionId).then();

    const rawHistory = groupId
      ? await getGroupHistory(
          groupId,
          ctx,
          cfg.historyCount,
          e.self_id,
          pluginCtx.db,
          pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
        )
      : [];
    const history: ChatMessage[] = rawHistory.map((msg: any) => ({
      sessionId: groupSessionId,
      role: "user" as const,
      content: msg.content,
      userId: msg.userId,
      userName: msg.userName,
      userRole: msg.userRole,
      groupId,
      timestamp: msg.timestamp,
      messageId: msg.messageId,
    }));

    // Check if message @s the bot - @bot triggers go direct, no planner
    const atSeg = e.message?.find((seg: any) => seg.type === "at");
    const isAtBot = !!(atSeg && String(atSeg.qq) === String(e.self_id));

    if (!isAtBot) {
      const botNickname =
        cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";
      const planResult = await pluginCtx.humanize.actionPlanner.plan(
        groupSessionId,
        botNickname,
        history,
        ctx.text(e) || "",
      );

      if (planResult.action === "complete" || planResult.action === "wait") {
        ctx.logger.info(
          `[Action Planning] Session ${groupSessionId} ${planResult.action}: ${planResult.reason}`,
        );
        if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
        return;
      }
    }

    const botNickname =
      cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";
    const botRole = groupId
      ? await getBotRole(groupId, ctx, e.self_id)
      : "member";
    let groupName: string | undefined;
    let memberCount: number | undefined;
    if (groupId) {
      const groupInfo = await pluginCtx.getGroupInfoData(
        ctx,
        groupId,
        e.self_id,
        e.group_name,
      );
      groupName = groupInfo.groupName;
      memberCount = groupInfo.memberCount;
    }

    const senderName = e.sender?.card || e.sender?.nickname || String(userId);
    const contexts = await pluginCtx.getHumanizeContexts(
      pluginCtx.humanize,
      groupSessionId,
      senderName,
      history,
      userId,
    );

    const targetMessage: TargetMessage = {
      userName: senderName,
      userId,
      userRole: e.sender?.role || "member",
      userTitle: (e.sender as any)?.title || undefined,
      content: messageContent,
      messageId: e.message_id,
      timestamp: Date.now(),
    };

    if (groupId)
      pluginCtx.queueManager.setActiveTarget(groupSessionId, targetMessage);

    const toolCtx = pluginCtx.buildToolContext({
      ctx,
      event: e,
      groupSessionId,
      groupId,
      userId,
      config: cfg,
      aiService: pluginCtx.aiService,
      db: pluginCtx.db,
      botRole,
      pendingImageUrls: imageUrls,
      humanize: pluginCtx.humanize,
      targetMessage,
      selfId: e.self_id,
    });

    const result = await pluginCtx.runWithRateLimitGuard(
      () =>
        pluginCtx.runChat(
          pluginCtx.aiInstance,
          toolCtx,
          history,
          targetMessage,
          {
            config: cfg,
            groupName,
            memberCount,
            botNickname,
            botRole,
            aiService: pluginCtx.aiService,
            isGroup,
            memoryContext: contexts.memoryContext,
            topicContext: contexts.topicContext,
            expressionContext: contexts.expressionContext,
            replyContext: {
              type: "reply",
              targetUser: targetMessage.userName,
              targetMessage: targetMessage.content,
            },
          },
          pluginCtx.humanize,
          pluginCtx.skillManager,
          groupId
            ? {
                manager: pluginCtx.groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: [
                  pluginCtx.buildStructuredUserInputFromTarget(targetMessage),
                ],
              }
            : undefined,
        ),
      { userId, groupId, label: isGroup ? "group-chat" : "private-chat" },
    );

    if (!result) {
      if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
      return;
    }

    if (groupId) {
      await pluginCtx.sendAIResponse(
        {
          ctx,
          groupId,
          messages: result.messages,
          config: cfg,
          sentIndices: toolCtx.sentMessageIndices,
          typoGenerator: pluginCtx.humanize.typoGenerator,
        },
        e.self_id,
      );
      await pluginCtx.sendEmoji(ctx, groupId, result.emojiPath, e.self_id);

      const now = Date.now();
      pluginCtx.saveBotMessages(
        groupId,
        groupSessionId,
        result.messages,
        now,
        cfg,
        pluginCtx.db,
        ctx,
        e.self_id,
      );
      pluginCtx.idleCheckManager.recordBotMessages(
        groupSessionId,
        result.messages.length,
        e.self_id,
      );

      pluginCtx.cooldownManager.startCooldownTimer(
        groupSessionId,
        groupId,
        e.self_id,
      );
    } else {
      const sentIndices = toolCtx.sentMessageIndices;
      for (let i = 0; i < result.messages.length; i++) {
        if (sentIndices?.has(i)) continue;
        await pluginCtx.sendMessage(
          ctx,
          undefined,
          userId,
          result.messages[i],
          cfg,
          pluginCtx.humanize.typoGenerator,
          e.self_id,
        );
      }
      if (result.emojiPath) {
        try {
          const emojiSegment = ctx.segment.image(`file://${result.emojiPath}`);
          await e.reply([emojiSegment]);
        } catch (err) {
          ctx.logger.warn(`[Emoticon] Send failed: ${err}`);
        }
      }
    }

    pluginCtx.sessionManager.touch(groupSessionId);
  } catch (err) {
    ctx.logger.error(`Chat processing failed: ${err}`);
    if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
  }
}

export default chatPlugin;
