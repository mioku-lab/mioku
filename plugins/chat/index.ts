import type { AITool } from "../../src";
import type {
  AIInstance,
  AIService,
  ChatRuntime,
  ChatRuntimeCollectedInfo,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimePromptInjection,
  ChatRuntimeResult,
} from "../../src/services/ai/types";
import type { ConfigService } from "../../src/services/config/tpyes";
import type { ScreenshotService } from "../../src/services/screenshot/types";
import { definePlugin, logger, MiokiContext } from "mioki";
import type {
  ChatConfig,
  ChatMessage,
  TargetMessage,
  ToolContext,
} from "./types";
import { initDatabase } from "./db";
import { SessionManager } from "./manage/session";
import { RateLimiter } from "./manage/rate-limiter";
import { runChat } from "./core/chat-engine";
import { HumanizeEngine } from "./humanize";
import { SkillSessionManager } from "./manage/skill-session";
import {
  extractContent,
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
  GroupStructuredHistoryManager,
  type StructuredUserInput,
} from "./manage/group-structured-history";
import {
  sendAIResponse,
  sendMessage,
  getGroupHistoryMessages,
  getGroupInfoData,
  getHumanizeContexts,
  buildToolContext,
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

function buildStructuredUserInput(
  params: StructuredUserInput,
): StructuredUserInput {
  return {
    userName: params.userName || "unknown",
    userId: params.userId || 0,
    userRole: params.userRole || "member",
    userTitle: params.userTitle,
    content: params.content,
    messageId: params.messageId,
    timestamp: params.timestamp,
  };
}

function buildHistoryMediaOptions(ai: AIInstance, config: ChatConfig) {
  return {
    ai,
    workingModel: config.workingModel || config.model,
    multimodalWorkingModel: config.multimodalWorkingModel || config.model,
  };
}

function buildHistoryMediaProcessingOptions(
  ai: AIInstance,
  config: ChatConfig,
  db: {
    getMediaSummary?(key: string): any;
    saveMediaSummary?(summary: any): void;
  },
  bot: {
    api<T = any>(action: string, params?: Record<string, any>): Promise<T>;
  },
  groupId: number,
  log: HistoryMediaProcessingOptions["logger"],
  runAIRequest?: <T>(request: () => Promise<T>) => Promise<T | null>,
): HistoryMediaProcessingOptions {
  return {
    ...buildHistoryMediaOptions(ai, config),
    db:
      db.getMediaSummary && db.saveMediaSummary
        ? {
            getMediaSummary: db.getMediaSummary.bind(db),
            saveMediaSummary: db.saveMediaSummary.bind(db),
          }
        : undefined,
    logger: log,
    bot,
    groupId,
    runAIRequest,
  };
}

function buildStructuredUserInputFromEvent(
  event: any,
  content: string,
  fallbackTimestamp: number = Date.now(),
): StructuredUserInput {
  return buildStructuredUserInput({
    userName:
      event?.sender?.card ||
      event?.sender?.nickname ||
      String(event?.user_id || event?.sender?.user_id || 0),
    userId: event?.user_id || event?.sender?.user_id || 0,
    userRole: event?.sender?.role || "member",
    userTitle: event?.sender?.title || undefined,
    content,
    messageId: event?.message_id,
    timestamp:
      typeof event?.time === "number" ? event.time * 1000 : fallbackTimestamp,
  });
}

function getSegmentUrl(seg: any): string | null {
  const url = seg?.url || seg?.data?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function getSegmentSourceCandidates(seg: any): string[] {
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
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

async function getVideoSourceCandidatesFromMessage(
  bot: { api<T = any>(action: string, params?: Record<string, any>): Promise<T> },
  messageId: number | string | undefined,
): Promise<string[]> {
  if (messageId == null) return [];
  const result = await bot.api("get_msg", { message_id: messageId });
  const segments = result?.message || result?.data?.message || [];
  if (!Array.isArray(segments)) return [];

  const candidates: string[] = [];
  for (const seg of segments) {
    if (seg?.type !== "video") continue;
    candidates.push(...getSegmentSourceCandidates(seg));
  }
  return candidates;
}

function getForwardId(seg: any): string | null {
  return seg?.id || seg?.data?.id || null;
}

function getCardData(seg: any): string | null {
  const data = seg?.data?.data || seg?.data?.xml || seg?.data || seg?.xml;
  if (!data) return null;
  return typeof data === "string" ? data : JSON.stringify(data);
}

function isMediaAnalysisBlocked(config: ChatConfig, userId: number): boolean {
  return Boolean(config.mediaAnalysisBlacklistUsers?.includes(userId));
}

function buildStructuredUserInputFromTarget(
  targetMessage: TargetMessage,
): StructuredUserInput {
  return buildStructuredUserInput({
    userName: targetMessage.userName,
    userId: targetMessage.userId,
    userRole: targetMessage.userRole,
    userTitle: targetMessage.userTitle,
    content: targetMessage.content,
    messageId: targetMessage.messageId,
    timestamp: targetMessage.timestamp,
  });
}

function normalizeIdList(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const ids = input
    .map((item) => Number(item))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id));
  return Array.from(new Set(ids));
}

type RuntimeReplyContextType =
  | "reply"
  | "comment"
  | "idle"
  | "review"
  | "poked";

interface ExecuteChatRuntimeRequestOptions {
  event?: any;
  selfId?: number;
  groupId?: number;
  userId?: number;
  config: ChatConfig;
  targetMessageContent?: string;
  promptInjections?: ChatRuntimePromptInjection[];
  extraTools?: AITool[];
  send?: boolean;
  replyContextType?: RuntimeReplyContextType;
}

interface ResolvedChatRuntimeContext {
  event: any;
  isGroup: boolean;
  groupId?: number;
  userId: number;
  selfId: number;
  sessionId: string;
  personalSessionId?: string;
  senderName: string;
  userRole: "owner" | "admin" | "member";
  userTitle?: string;
  groupName?: string;
  messageId?: number;
}

const chatPlugin = definePlugin({
  name: "chat",
  version: "1.0.0",
  description: "AI 智能聊天插件",

  async setup(ctx: MiokiContext) {
    ctx.logger.info("聊天插件正在初始化...");

    // 获取服务
    const aiService = ctx.services?.ai as AIService | undefined;
    const configService = ctx.services?.config as ConfigService | undefined;
    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;
    let warnedMarkdownScreenshotUnavailable = false;

    // 注册配置
    if (configService) {
      await configService.registerConfig("chat", "base", BASE_CONFIG);
      await configService.registerConfig("chat", "settings", SETTINGS_CONFIG);
      await configService.registerConfig(
        "chat",
        "personalization",
        PERSONALIZATION_CONFIG,
      );
    }

    // 获取配置
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

      if (typeof merged.stream !== "boolean") {
        merged.stream = true;
      }
      if (typeof merged.enableMarkdownScreenshot !== "boolean") {
        merged.enableMarkdownScreenshot = true;
      }
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

    // 初始化组件
    const db = await initDatabase();
    const sessionManager = new SessionManager(db, config.maxSessions);
    const queueManager = new MessageQueueManager();
    const rateLimiter = new RateLimiter({
      dynamicDelay: config.dynamicDelay,
      aiRequestLimits: config.aiRequestLimits,
    });
    const skillManager = new SkillSessionManager();

    // 注入队列长度获取函数到 rateLimiter
    rateLimiter.setQueueLengthGetter((groupId: number) => {
      const sessionId = `group:${groupId}`;
      return queueManager.getQueueLength(sessionId);
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

    // 数据结构初始化
    const humanize = new HumanizeEngine(aiInstance, config, db);
    await humanize.init();
    const pokeCooldowns = new Map<number, number>();
    const POKE_COOLDOWN_MS = 10 * 60_000;
    const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
    const RATE_LIMIT_MAX_RETRIES = 2;
    let rateLimitBlockedUntil = 0;
    const processingSet = new Set<string>();
    const groupStructuredHistory = new GroupStructuredHistoryManager();
    const groupLastActivityTime = new Map<string, number>();
    const groupMessageCount = new Map<string, number>();
    const groupLastBotMessageTime = new Map<string, number>();
    const groupMessageCountAfterBot = new Map<string, number>();
    const groupCooldownUntil = new Map<string, number>();
    const groupCooldownMessages = new Map<
      string,
      Array<{
        event: any;
        content: string;
        userName: string;
        userId: number;
        messageId: number;
        timestamp: number;
        isDirectAt: boolean;
      }>
    >();
    // 正在等待冷却触发的计时器
    const cooldownTimeoutIds = new Map<string, NodeJS.Timeout>();
    // 群到 bot 集合的映射 (groupSessionId -> Set<selfId>)
    const groupBotsMapping = new Map<string, Set<number>>();

    // 动态延迟队列：群ID -> { messages, timer, delayUntil }
    const dynamicDelayQueues = new Map<
      string,
      {
        messages: Array<{
          event: any;
          content: string;
          userName: string;
          userId: number;
          messageId: number;
          timestamp: number;
        }>;
        timer: NodeJS.Timeout | null;
        delayUntil: number;
      }
    >();

    function isRateLimitError(err: unknown): boolean {
      const errStr = String(err).toLowerCase();
      return errStr.includes("429") || errStr.includes("rate limit");
    }

    function isRateLimitBlocked(): boolean {
      return Date.now() < rateLimitBlockedUntil;
    }

    function markRateLimitBlocked(): void {
      rateLimitBlockedUntil = Date.now() + RATE_LIMIT_RETRY_DELAY_MS;
    }

    async function runWithRateLimitGuard<T>(
      request: () => Promise<T>,
      options?: {
        userId?: number;
        groupId?: number;
        label?: string;
      },
    ): Promise<T | null> {
      if (isRateLimitBlocked()) {
        ctx.logger.warn(
          `[Chat] AI request skipped due to active rate limit block${options?.label ? ` (${options.label})` : ""}`,
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
          if (!isRateLimitError(err)) {
            throw err;
          }

          markRateLimitBlocked();
          if (retries >= RATE_LIMIT_MAX_RETRIES) {
            throw err;
          }

          retries += 1;
          ctx.logger.warn(
            `[Chat] Rate limit hit, waiting ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s to retry...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS),
          );
          if (isRateLimitBlocked()) {
            rateLimitBlockedUntil = 0;
          }
        }
      }
    }

    function buildRuntimeTargetMessageContent(
      event: any,
      overrideContent?: string,
    ): string {
      const content =
        overrideContent?.trim() || (event ? ctx.text(event)?.trim() : "") || "";
      if (content) {
        return content;
      }
      return "[No new user message in this turn. Reply naturally based on the runtime instruction and recent context.]";
    }

    function resolveChatRuntimeContext(
      options: ExecuteChatRuntimeRequestOptions,
    ): ResolvedChatRuntimeContext {
      if (options.event) {
        const event = options.event;
        const isGroup = event.message_type === "group";
        const groupId: number | undefined = isGroup
          ? event.group_id
          : undefined;
        const userId: number = event.user_id || event.sender?.user_id || 0;
        const selfId: number = event.self_id;
        return {
          event,
          isGroup,
          groupId,
          userId,
          selfId,
          sessionId: groupId ? `group:${groupId}` : `personal:${userId}`,
          personalSessionId: groupId ? `personal:${userId}` : undefined,
          senderName:
            event.sender?.card || event.sender?.nickname || String(userId),
          userRole: event.sender?.role || "member",
          userTitle: event.sender?.title || undefined,
          groupName: event.group_name,
          messageId: event.message_id,
        };
      }

      if (typeof options.selfId !== "number") {
        throw new Error("Chat runtime requires either event or selfId");
      }
      if (
        typeof options.groupId !== "number" &&
        typeof options.userId !== "number"
      ) {
        throw new Error("Chat runtime requires groupId or userId");
      }

      const isGroup = typeof options.groupId === "number";
      const userId = options.userId ?? 0;
      const event = {
        self_id: options.selfId,
        message_type: isGroup ? "group" : "private",
        group_id: options.groupId,
        user_id: userId,
        message: [],
        group_name: undefined,
        sender: {
          user_id: userId,
          card: undefined,
          nickname: undefined,
          role: "member",
          title: undefined,
        },
      };

      return {
        event,
        isGroup,
        groupId: options.groupId,
        userId,
        selfId: options.selfId,
        sessionId: options.groupId
          ? `group:${options.groupId}`
          : `personal:${userId}`,
        personalSessionId:
          options.groupId && userId ? `personal:${userId}` : undefined,
        senderName: options.groupId ? "system" : String(userId),
        userRole: "member",
        userTitle: undefined,
        groupName: undefined,
        messageId: undefined,
      };
    }

    async function executeChatRuntimeRequest(
      options: ExecuteChatRuntimeRequestOptions,
    ): Promise<ChatRuntimeResult> {
      const cfg = options.config;
      const runtimeCtx = resolveChatRuntimeContext(options);
      const {
        event,
        isGroup,
        groupId,
        userId,
        selfId,
        sessionId,
        personalSessionId,
        senderName,
        userRole,
        userTitle,
        groupName: runtimeGroupName,
        messageId,
      } = runtimeCtx;
      const targetContent = buildRuntimeTargetMessageContent(
        event,
        options.targetMessageContent,
      );

      sessionManager.getOrCreate(
        sessionId,
        groupId ? "group" : "personal",
        groupId ?? userId,
      );
      if (groupId && personalSessionId) {
        sessionManager.getOrCreate(personalSessionId, "personal", userId);
      }

      const rawHistory = groupId
        ? await getGroupHistory(
            groupId,
            ctx,
            cfg.historyCount,
            selfId,
            db,
            buildHistoryMediaOptions(aiInstance, cfg),
          )
        : [];
      const history: ChatMessage[] = rawHistory.map((msg) => ({
        sessionId,
        role: "user",
        content: msg.content,
        userId: msg.userId,
        userName: msg.userName,
        userRole: msg.userRole,
        groupId,
        timestamp: msg.timestamp,
        messageId: msg.messageId,
      }));

      const botRole = groupId
        ? await getBotRole(groupId, ctx, selfId)
        : "member";
      const botNickname =
        cfg.nicknames[0] || ctx.pickBot(selfId)?.nickname || "Bot";

      let groupName: string | undefined;
      let memberCount: number | undefined;
      if (groupId) {
        const groupInfo = await getGroupInfoData(
          ctx,
          groupId,
          selfId,
          runtimeGroupName,
        );
        groupName = groupInfo.groupName;
        memberCount = groupInfo.memberCount;
      } else {
        groupName = runtimeGroupName;
      }

      const contexts = await getHumanizeContexts(
        humanize,
        sessionId,
        targetContent,
        senderName,
        history,
        userId,
      );

      const targetMessage: TargetMessage = {
        userName: senderName,
        userId,
        userRole,
        userTitle,
        content: targetContent,
        messageId,
        timestamp: Date.now(),
      };

      const toolCtx = buildToolContext({
        ctx,
        event,
        groupSessionId: sessionId,
        groupId,
        userId,
        config: cfg,
        aiService: aiService!,
        db,
        botRole,
        humanize,
        targetMessage,
        selfId,
      });

      if (options.send === false) {
        toolCtx.onTextContent = undefined;
        toolCtx.sentMessageIndices = undefined;
      }

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
                isGroup,
                memoryContext: contexts.memoryContext,
                topicContext: contexts.topicContext,
                expressionContext: contexts.expressionContext,
                replyContext: {
                  type: options.replyContextType || "reply",
                  targetUser: targetMessage.userName,
                  targetMessage: targetMessage.content,
                },
                promptInjections: options.promptInjections,
              },
              humanize,
              skillManager,
              undefined,
              {
                extraTools: options.extraTools,
              },
            ),
          {
            userId,
            groupId,
            label: "chat-runtime",
          },
        );
      if (!result) {
        return {
          messages: [],
          toolCalls: [],
          collectedInfo: null,
        };
      }

      if (options.send !== false) {
        if (groupId) {
          await sendAIResponse(
            {
              ctx,
              groupId,
              messages: result.messages,
              config: cfg,
              sentIndices: toolCtx.sentMessageIndices,
              typoGenerator: humanize.typoGenerator,
            },
            selfId,
          );

          await sendEmoji(ctx, groupId, result.emojiPath, selfId);

          const now = Date.now();
          saveBotMessages(
            groupId,
            sessionId,
            result.messages,
            now,
            cfg,
            db,
            ctx,
            groupLastBotMessageTime,
            groupMessageCountAfterBot,
            selfId,
          );

          startCooldownTimer(sessionId, groupId, selfId);
        } else {
          const sentIndices = toolCtx.sentMessageIndices;
          for (let i = 0; i < result.messages.length; i++) {
            if (sentIndices?.has(i)) continue;
            await sendMessage(
              ctx,
              undefined,
              userId,
              result.messages[i],
              cfg,
              humanize.typoGenerator,
              selfId,
            );
          }

          if (result.emojiPath) {
            try {
              const emojiSegment = ctx.segment.image(
                `file://${result.emojiPath}`,
              );
              const bot = ctx.pickBot(selfId);
              if (!bot) {
                throw new Error(`bot ${String(selfId)} not found`);
              }
              await bot.sendPrivateMsg(userId, [emojiSegment]);
            } catch (err) {
              ctx.logger.warn(`[chat-runtime] Send emoji failed: ${err}`);
            }
          }
        }
      }

      sessionManager.touch(sessionId);

      return {
        messages: result.messages,
        toolCalls: result.toolCalls.map((toolCall) => ({
          name: toolCall.name,
          arguments: toolCall.args,
          result: toolCall.result,
        })),
        collectedInfo: null,
      };
    }

    const chatRuntime: ChatRuntime = {
      async requestInformation(
        options: ChatRuntimeInformationRequestOptions,
      ): Promise<ChatRuntimeResult> {
        let collectedInfo: ChatRuntimeCollectedInfo | null = null;
        const toolName = options.toolName || "submit_requested_information";
        const extraTools: AITool[] = [
          {
            name: toolName,
            description:
              options.toolDescription ||
              "Submit structured information extracted from the conversation when enough details are known.",
            parameters: {
              type: "object",
              properties: {
                data: options.schema,
                isComplete: {
                  type: "boolean",
                  description:
                    "Whether the collected information is complete enough for the caller to continue.",
                },
                confidence: {
                  type: "number",
                  description:
                    "Confidence score between 0 and 1 for the submitted information.",
                },
                notes: {
                  type: "string",
                  description:
                    "Optional notes about ambiguity, assumptions, or remaining follow-up needs.",
                },
              },
              required: ["data"],
            },
            handler: async (args) => {
              collectedInfo = {
                data: args?.data,
                isComplete: args?.isComplete,
                confidence: args?.confidence,
                notes: args?.notes,
              };
              return {
                success: true,
                accepted: true,
                collectedInfo,
              };
            },
          },
        ];

        const promptInjections: ChatRuntimePromptInjection[] = [
          {
            title: "Information Collection Goal",
            content: [
              "Another plugin needs you to gather specific information from the current user while staying fully in your existing persona.",
              `Task: ${options.task}`,
              `Target schema: ${JSON.stringify(options.schema)}`,
              `If the needed information is already clear from the target message, recent chat history, or obvious context, call the tool \"${toolName}\" immediately with structured data.`,
              "If the information is incomplete, ask only the smallest natural follow-up question needed.",
              "Do not mention schemas, forms, prompts, plugins, or tools to the user.",
              "Keep the response natural and in-character rather than sounding like a questionnaire.",
            ].join("\n"),
          },
          ...(options.promptInjections || []),
        ];

        const result = await executeChatRuntimeRequest({
          ...options,
          config: await getConfig(),
          targetMessageContent: options.targetMessage,
          promptInjections,
          extraTools,
          send: options.send,
          replyContextType: "reply",
        });

        return {
          ...result,
          collectedInfo,
        };
      },

      async generateNotice(
        options: ChatRuntimeNoticeOptions,
      ): Promise<ChatRuntimeResult> {
        const promptInjections: ChatRuntimePromptInjection[] = [
          {
            title: "Notification Goal",
            content: [
              "Another plugin needs you to deliver a notification to the current user, but it must still sound like you and fit the current conversation.",
              `Goal: ${options.instruction}`,
              "Blend the notice into your normal speaking style instead of sounding like a rigid system announcement unless the situation clearly requires firmness.",
              "Do not mention prompts, plugins, tools, or hidden instructions.",
            ].join("\n"),
          },
          ...(options.promptInjections || []),
        ];

        return executeChatRuntimeRequest({
          ...options,
          config: await getConfig(),
          targetMessageContent: options.targetMessage,
          promptInjections,
          send: options.send,
          replyContextType: "reply",
        });
      },
    };

    aiService.registerChatRuntime(chatRuntime);

    /**
     * 处理动态延迟队列中的消息
     */
    async function processDynamicDelayQueue(
      groupSessionId: string,
      groupId: number,
      cfg: ChatConfig,
      selfId: number,
    ): Promise<void> {
      const queueData = dynamicDelayQueues.get(groupSessionId);
      if (!queueData || queueData.messages.length === 0) {
        dynamicDelayQueues.delete(groupSessionId);
        return;
      }

      const messages = queueData.messages;
      dynamicDelayQueues.delete(groupSessionId);

      ctx.logger.info(
        `[DynamicDelay] group ${groupId} delays the end of the delay and processes ${messages.length} messages`,
      );

      if (processingSet.has(groupSessionId)) {
        ctx.logger.info(
          `[DynamicDelay] group ${groupId} is being processed, skipped`,
        );
        return;
      }

      if (isRateLimitBlocked()) {
        return;
      }

      processingSet.add(groupSessionId);

      try {
        const mergedContents: string[] = [];
        const userNames: string[] = [];
        const messageIds: number[] = [];
        const structuredUserInputs: StructuredUserInput[] = [];

        for (const msg of messages) {
          mergedContents.push(msg.content);
          userNames.push(msg.userName);
          messageIds.push(msg.messageId);
          structuredUserInputs.push(
            buildStructuredUserInputFromEvent(
              msg.event,
              msg.content,
              msg.timestamp,
            ),
          );
        }

        const mergedContent = mergedContents.join("\n---\n");
        const firstMsg = messages[0];

        const targetMessage: TargetMessage = {
          userName: userNames.join(", "),
          userId: firstMsg.userId,
          userRole: "member",
          content: mergedContent,
          messageId: firstMsg.messageId,
          timestamp: Date.now(),
        };

        const botRole = await getBotRole(groupId, ctx, selfId);
        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(selfId).nickname || "Bot";

        const { groupName, memberCount } = await getGroupInfoData(
          ctx,
          groupId,
          selfId,
          String(groupId),
        );

        const { history } = await getGroupHistoryMessages(
          groupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          db,
          selfId,
          buildHistoryMediaOptions(aiInstance, cfg),
        );

        const toolCtx: ToolContext = buildToolContext({
          ctx,
          event: firstMsg.event,
          groupSessionId,
          groupId,
          userId: firstMsg.userId,
          config: cfg,
          aiService: aiService!,
          db,
          botRole,
          humanize,
          targetMessage,
          selfId,
        });

        sessionManager.getOrCreate(groupSessionId, "group", groupId);

        const contexts = await getHumanizeContexts(
          humanize,
          groupSessionId,
          mergedContent,
          targetMessage.userName,
          history,
          targetMessage.userId,
        );

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
                memoryContext: contexts.memoryContext,
                topicContext: contexts.topicContext,
                expressionContext: contexts.expressionContext,
                replyContext: {
                  type: "review",
                  targetUser: targetMessage.userName,
                  targetMessage: targetMessage.content,
                },
                reviewMessages: {
                  contents: mergedContents,
                  userNames,
                  messageIds,
                },
              },
              humanize,
              skillManager,
              {
                manager: groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: structuredUserInputs,
              },
            ),
          {
            userId: targetMessage.userId,
            groupId,
            label: "dynamic-delay",
          },
        );
        if (!result) {
          return;
        }

        await sendAIResponse(
          {
            ctx,
            groupId,
            messages: result.messages,
            config: cfg,
            sentIndices: toolCtx.sentMessageIndices,
            typoGenerator: humanize.typoGenerator,
          },
          selfId,
        );

        rateLimiter.clearGroupInteractions(groupId);
        startCooldownTimer(groupSessionId, groupId, selfId);
      } catch (err) {
        ctx.logger.error(
          `[DynamicDelay] group ${groupId} processing failed: ${err}`,
        );
      } finally {
        processingSet.delete(groupSessionId);
      }
    }

    /**
     * 启动动态延迟计时器
     */
    function startDynamicDelayTimer(
      groupSessionId: string,
      groupId: number,
      delayMs: number,
      cfg: ChatConfig,
      selfId: number,
    ): void {
      let queueData = dynamicDelayQueues.get(groupSessionId);

      if (!queueData) {
        queueData = {
          messages: [],
          timer: null,
          delayUntil: Date.now() + delayMs,
        };
        dynamicDelayQueues.set(groupSessionId, queueData);
      }

      if (queueData.timer) {
        clearTimeout(queueData.timer);
      }

      queueData.delayUntil = Date.now() + delayMs;

      ctx.logger.info(
        `[DynamicDelay] group ${groupId} start delay ${delayMs / 1000} seconds, current number of interactions: ${rateLimiter.getInteractionCount(groupId)}`,
      );

      queueData.timer = setTimeout(async () => {
        await processDynamicDelayQueue(groupSessionId, groupId, cfg, selfId);
      }, delayMs);
    }

    /**
     * 收集消息到动态延迟队列
     */
    function collectDynamicDelayMessage(
      groupSessionId: string,
      event: any,
      content: string,
    ): void {
      let queueData = dynamicDelayQueues.get(groupSessionId);

      if (!queueData) {
        queueData = {
          messages: [],
          timer: null,
          delayUntil: 0,
        };
        dynamicDelayQueues.set(groupSessionId, queueData);
      }

      const userName =
        event.sender?.card || event.sender?.nickname || String(event.user_id);

      queueData.messages.push({
        event,
        content,
        userName,
        userId: event.user_id,
        messageId: event.message_id,
        timestamp: Date.now(),
      });
    }

    /**
     * 启动冷却计时器
     */
    function startCooldownTimer(
      groupSessionId: string,
      groupId: number,
      selfId: number,
    ) {
      // 清除之前的计时器
      const existingTimer = cooldownTimeoutIds.get(groupSessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const cfg = config;
      const cooldownMs = cfg.cooldownAfterReplyMs ?? 20_000;

      const timer = setTimeout(async () => {
        // 清除计时器记录
        cooldownTimeoutIds.delete(groupSessionId);

        // 获取收集的消息
        const collected = groupCooldownMessages.get(groupSessionId) || [];

        if (collected.length === 0) {
          ctx.logger.info(
            `[Cooldown] Group ${groupId} has no message during cooldown, ignored`,
          );
          groupCooldownMessages.delete(groupSessionId);
          groupCooldownUntil.delete(groupSessionId);
          return;
        }

        // 检查是否有直接 @bot 的消息
        const directAtMessages = collected.filter((m) => m.isDirectAt);

        try {
          if (directAtMessages.length > 0) {
            // 有直接 @bot 的消息，使用 review 模式处理
            await processReviewMessages(
              groupSessionId,
              groupId,
              collected,
              cfg,
              selfId,
            );
          } else {
            // 没有直接 @bot，使用 planner 决定是否回复
            await processCooldownWithPlanner(
              groupSessionId,
              groupId,
              collected,
              cfg,
              selfId,
            );
          }
        } catch (err) {
          ctx.logger.error(
            `[Cooldown] Group ${groupId} processing failed: ${err}`,
          );
        } finally {
          groupCooldownMessages.delete(groupSessionId);
          groupCooldownUntil.delete(groupSessionId);
        }
      }, cooldownMs);

      cooldownTimeoutIds.set(groupSessionId, timer);
      groupCooldownUntil.set(groupSessionId, Date.now() + cooldownMs);
      groupCooldownMessages.set(groupSessionId, []);
    }

    /**
     * 在冷却期间收集消息
     */
    function collectCooldownMessage(
      groupSessionId: string,
      groupId: number,
      event: any,
      content: string,
      isDirectAt: boolean,
    ) {
      const userName =
        event.sender?.card || event.sender?.nickname || String(event.user_id);

      const messages = groupCooldownMessages.get(groupSessionId) || [];
      messages.push({
        event,
        content,
        userName,
        userId: event.user_id,
        messageId: event.message_id,
        timestamp: Date.now(),
        isDirectAt,
      });
      groupCooldownMessages.set(groupSessionId, messages);
    }

    /**
     * 处理 review 模式的消息
     */
    async function processReviewMessages(
      groupSessionId: string,
      groupId: number,
      collected: Array<{
        event: any;
        content: string;
        userName: string;
        userId: number;
        messageId: number;
        timestamp: number;
        isDirectAt: boolean;
      }>,
      cfg: ChatConfig,
      selfId: number,
    ) {
      // 如果群正在处理，跳过
      if (processingSet.has(groupSessionId)) {
        ctx.logger.info(
          `[Review] group ${groupId} is being processed, skipping review`,
        );
        return;
      }

      processingSet.add(groupSessionId);

      try {
        // 合并所有 @bot 消息内容
        const mergedContents: string[] = [];
        const userNames: string[] = [];
        const messageIds: number[] = [];

        for (const msg of collected) {
          mergedContents.push(msg.content);
          userNames.push(msg.userName);
          messageIds.push(msg.messageId);
        }

        const mergedContent = mergedContents.join("\n---\n");
        const firstMsg = collected[0];

        // 构建 targetMessage
        const targetMessage: TargetMessage = {
          userName: userNames.join(", "),
          userId: firstMsg.userId,
          userRole: firstMsg.event.sender?.role || "member",
          content: mergedContent,
          messageId: firstMsg.messageId,
          timestamp: Date.now(),
        };

        const { history } = await getGroupHistoryMessages(
          groupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          db,
          selfId,
          buildHistoryMediaOptions(aiInstance, cfg),
        );

        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(selfId).nickname || "Bot";
        const botRole = await getBotRole(groupId, ctx, selfId);

        const { groupName, memberCount } = await getGroupInfoData(
          ctx,
          groupId,
          selfId,
        );

        const toolCtx: ToolContext = buildToolContext({
          ctx,
          event: firstMsg.event,
          groupSessionId,
          groupId,
          userId: targetMessage.userId,
          config: cfg,
          aiService: aiService!,
          db,
          botRole,
          humanize,
          targetMessage,
          selfId,
        });

        const contexts = await getHumanizeContexts(
          humanize,
          groupSessionId,
          mergedContent,
          targetMessage.userName,
          history,
          targetMessage.userId,
        );

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
                memoryContext: contexts.memoryContext,
                topicContext: contexts.topicContext,
                expressionContext: contexts.expressionContext,
                replyContext: {
                  type: "review",
                  targetUser: targetMessage.userName,
                  targetMessage: targetMessage.content,
                },
                reviewMessages: {
                  contents: mergedContents,
                  userNames,
                  messageIds,
                },
              },
              humanize,
              skillManager,
              {
                manager: groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: collected.map((msg) =>
                  buildStructuredUserInputFromEvent(
                    msg.event,
                    msg.content,
                    msg.timestamp,
                  ),
                ),
              },
            ),
          {
            userId: targetMessage.userId,
            groupId,
            label: "cooldown",
          },
        );
        if (!result) {
          return;
        }

        await sendAIResponse(
          {
            ctx,
            groupId,
            messages: result.messages,
            config: cfg,
            sentIndices: toolCtx.sentMessageIndices,
            typoGenerator: humanize.typoGenerator,
          },
          selfId,
        );

        await sendEmoji(ctx, groupId, result.emojiPath, selfId);

        const now = Date.now();
        saveBotMessages(
          groupId,
          groupSessionId,
          result.messages,
          now,
          cfg,
          db,
          ctx,
          groupLastBotMessageTime,
          groupMessageCountAfterBot,
          selfId,
        );

        sessionManager.touch(groupSessionId);

        // 重新启动冷却计时器（处理完这批消息后）
        startCooldownTimer(groupSessionId, groupId, selfId);
      } finally {
        processingSet.delete(groupSessionId);
      }
    }

    /**
     * 使用 planner 判断是否回复收集的消息
     */
    async function processCooldownWithPlanner(
      groupSessionId: string,
      groupId: number,
      collected: Array<{
        event: any;
        content: string;
        userName: string;
        userId: number;
        messageId: number;
        timestamp: number;
        isDirectAt: boolean;
      }>,
      cfg: ChatConfig,
      selfId: number,
    ) {
      if (processingSet.has(groupSessionId)) {
        return;
      }

      processingSet.add(groupSessionId);

      try {
        // 合并消息内容
        const mergedContent = collected.map((m) => m.content).join("\n");
        const firstMsg = collected[0];

        const { history } = await getGroupHistoryMessages(
          groupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          db,
          selfId,
          buildHistoryMediaOptions(aiInstance, cfg),
        );

        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(selfId).nickname || "Bot";

        // 使用 planner 判断
        const planResult = await humanize.actionPlanner.plan(
          groupSessionId,
          botNickname,
          history,
          mergedContent,
        );

        if (planResult.action === "reply") {
          const targetMessage: TargetMessage = {
            userName: firstMsg.userName,
            userId: firstMsg.userId,
            userRole: firstMsg.event.sender?.role || "member",
            content: mergedContent,
            messageId: firstMsg.messageId,
            timestamp: Date.now(),
          };

          const botRole = await getBotRole(groupId, ctx, selfId);

          const toolCtx: ToolContext = buildToolContext({
            ctx,
            event: firstMsg.event,
            groupSessionId,
            groupId,
            userId: targetMessage.userId,
            config: cfg,
            aiService: aiService!,
            db,
            botRole,
            humanize,
            targetMessage,
            selfId,
          });

          const { groupName, memberCount } = await getGroupInfoData(
            ctx,
            groupId,
            selfId,
          );

          const contexts = await getHumanizeContexts(
            humanize,
            groupSessionId,
            mergedContent,
            targetMessage.userName,
            history,
            targetMessage.userId,
          );

          const plannerThoughts = `After you spoke, the following messages were sent in the group. Use this context to respond naturally.
Planned reason: ${planResult.reason}`;

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
                  botRole: toolCtx.botRole,
                  aiService: aiService!,
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
                humanize,
                skillManager,
                {
                  manager: groupStructuredHistory,
                  ttlMs: cfg.groupStructuredHistoryTtlMs,
                  currentUserInputs: collected.map((msg) =>
                    buildStructuredUserInputFromEvent(
                      msg.event,
                      msg.content,
                      msg.timestamp,
                    ),
                  ),
                },
              ),
            {
              userId: targetMessage.userId,
              groupId,
              label: "cooldown-planner",
            },
          );
          if (!result) {
            ctx.logger.warn(
              `[CooldownPlanner] Group ${groupId} AI request skipped`,
            );
            return;
          }

          await sendAIResponse(
            {
              ctx,
              groupId,
              messages: result.messages,
              config: cfg,
              sentIndices: toolCtx.sentMessageIndices,
              typoGenerator: humanize.typoGenerator,
            },
            selfId,
          );

          await sendEmoji(ctx, groupId, result.emojiPath, selfId);

          const now = Date.now();
          saveBotMessages(
            groupId,
            groupSessionId,
            result.messages,
            now,
            cfg,
            db,
            ctx,
            groupLastBotMessageTime,
            groupMessageCountAfterBot,
            selfId,
          );

          sessionManager.touch(groupSessionId);

          // 重新启动冷却计时器
          startCooldownTimer(groupSessionId, groupId, selfId);
        } else {
          ctx.logger.info(
            `[CooldownPlanner] Group ${groupId} planner decided not to reply: ${planResult.reason}`,
          );
        }
      } finally {
        processingSet.delete(groupSessionId);
      }
    }

    // 定期清理过期技能会话
    const cleanupInterval = setInterval(
      () => skillManager.cleanup(),
      10 * 60_000,
    );

    // 群是否正在处理
    const idleCheckProcessing = new Set<string>();
    // 群最后一次空闲检查时间
    const groupLastIdleCheckTime = new Map<string, number>();

    // 空闲检测定时器
    const idleCheckInterval = setInterval(async () => {
      try {
        const cfg = await getConfig();
        if (!cfg.apiKey || !cfg.planner?.enabled) return;

        const now = Date.now();
        const idleThreshold = cfg.planner.idleThresholdMs ?? 30 * 60_000;
        const messageCountThreshold = cfg.planner.idleMessageCount ?? 100;
        const checkInterval = 60_000;
        const allBotIds = Array.from(ctx.bots).map((bot) => bot.uin);
        const idleCheckBotIds = cfg.planner.idleCheckBotIds ?? allBotIds;
        const enabledBotIds = idleCheckBotIds.filter((id) =>
          allBotIds.includes(id),
        );

        for (const [groupSessionId, lastTime] of groupLastActivityTime) {
          const lastCheckTime = groupLastIdleCheckTime.get(groupSessionId) ?? 0;
          if (now - lastCheckTime < checkInterval) continue;

          if (
            processingSet.has(groupSessionId) ||
            idleCheckProcessing.has(groupSessionId)
          ) {
            continue;
          }

          const groupId = parseInt(groupSessionId.split(":")[1], 10);
          if (!isGroupAllowed(groupId, cfg)) continue;

          let lastBotTime = groupLastBotMessageTime.get(groupSessionId) ?? 0;
          if (lastBotTime === 0) {
            const botMsgs = db.getBotMessages(groupId, 1);
            if (botMsgs.length > 0) {
              lastBotTime = botMsgs[botMsgs.length - 1].timestamp;
              groupLastBotMessageTime.set(groupSessionId, lastBotTime);
            }
          }

          const lastActivityTime = Math.max(lastTime, lastBotTime);
          if (now - lastActivityTime < idleThreshold) continue;

          const messageCountAfterBot =
            groupMessageCountAfterBot.get(groupSessionId) ?? 0;
          const messageCount =
            lastBotTime > 0
              ? messageCountAfterBot
              : (groupMessageCount.get(groupSessionId) ?? 0);
          if (messageCount < messageCountThreshold) continue;

          const botsInGroup = groupBotsMapping.get(groupSessionId);
          if (!botsInGroup || botsInGroup.size === 0) continue;

          const availableBots = Array.from(botsInGroup).filter((id) =>
            enabledBotIds.includes(id),
          );
          if (availableBots.length === 0) continue;

          const selfId =
            availableBots[Math.floor(Math.random() * availableBots.length)];

          idleCheckProcessing.add(groupSessionId);

          try {
            ctx.logger.info(
              `[IdleCheck] group ${groupId} triggers idle detection`,
            );

            const { history } = await getGroupHistoryMessages(
              groupId,
              groupSessionId,
              ctx,
              cfg.historyCount,
              db,
              selfId,
              buildHistoryMediaOptions(aiInstance, cfg),
            );

            const botNickname =
              cfg.nicknames[0] || ctx.pickBot(selfId).nickname || "Bot";

            const planResult = await humanize.actionPlanner.plan(
              groupSessionId,
              botNickname,
              history,
              "[Check if you want to answer the call]",
              true,
            );

            if (planResult.action === "reply") {
              const targetMessage: TargetMessage = {
                userName: "system",
                userId: 0,
                userRole: "member",
                content: "[No one in the group is talking? I'll answer!]",
                messageId: 0,
                timestamp: now,
              };

              const botRole = await getBotRole(groupId, ctx, selfId);

              const toolCtx: ToolContext = buildToolContext({
                ctx,
                event: null,
                groupSessionId,
                groupId,
                userId: 0,
                config: cfg,
                aiService: aiService!,
                db,
                botRole,
                humanize,
                targetMessage,
                selfId,
              });

              const plannerThoughts = `You stumbled upon some message in this group and decided to reply.
Suggestion:
- Quote messages from group friends appropriately (using [[[reply:message ID]]] format)
- Don't mention your intentions like "I'm here to answer" or something like a normal chat`;

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
                      aiService: aiService!,
                      isGroup: true,
                      plannerThoughts,
                      replyContext: {
                        type: "idle",
                      },
                    },
                    humanize,
                    skillManager,
                  ),
                {
                  groupId,
                  label: "idle-check",
                },
              );
              if (!result) {
                groupMessageCount.set(groupSessionId, 0);
                groupMessageCountAfterBot.set(groupSessionId, 0);
                groupLastIdleCheckTime.set(groupSessionId, now);
                return;
              }

              await sendAIResponse(
                {
                  ctx,
                  groupId,
                  messages: result.messages,
                  config: cfg,
                  sentIndices: toolCtx.sentMessageIndices,
                  typoGenerator: humanize.typoGenerator,
                },
                selfId,
              );

              const now2 = Date.now();
              saveBotMessages(
                groupId,
                groupSessionId,
                result.messages,
                now2,
                cfg,
                db,
                ctx,
                groupLastBotMessageTime,
                groupMessageCountAfterBot,
                selfId,
              );

              startCooldownTimer(groupSessionId, groupId, selfId);

              ctx.logger.info(
                `[IdleCheck] group ${groupId} idle reply completed`,
              );
            }

            groupMessageCount.set(groupSessionId, 0);
            groupMessageCountAfterBot.set(groupSessionId, 0);
            groupLastIdleCheckTime.set(groupSessionId, now);
          } catch (err) {
            ctx.logger.error(
              `[IdleCheck] group ${groupId} idle detection failed: ${err}`,
            );
          } finally {
            idleCheckProcessing.delete(groupSessionId);
          }
        }
      } catch (err) {}
    }, 60_000);

    /**
     * 处理队列中的等待消息
     * 将队列中所有消息合并后一次性发送给 AI，只请求一次
     */
    async function processQueuedMessages(
      groupSessionId: string,
      cfg: ChatConfig,
      selfId: number,
    ): Promise<void> {
      // 获取当前队列中的所有消息
      try {
        const queue = queueManager.getQueue(groupSessionId);
        if (!queue || queue.length === 0) {
          queueManager.clearActiveTarget(groupSessionId);
          return;
        }

        if (isRateLimitBlocked()) {
          queueManager.clearQueue(groupSessionId);
          queueManager.clearActiveTarget(groupSessionId);
          return;
        }

        // 检查是否处于冷却期，如果是则让冷却计时器处理这批消息
        const cooldownUntil = groupCooldownUntil.get(groupSessionId) ?? 0;
        if (Date.now() < cooldownUntil) {
          ctx.logger.info(
            `[Queue] group ${groupSessionId} is in cooldown, queue deferred to cooldown handler`,
          );
          return;
        }

        ctx.logger.info(
          `[Queue] group ${groupSessionId} batch queue, queue length: ${queue.length}`,
        );

        // 收集所有队列消息的内容
        const queuedContents: string[] = [];
        const structuredUserInputs: StructuredUserInput[] = [];
        for (const item of queue) {
          const { text: extractedText, multimodal } = extractContent(
            item.event,
            cfg,
            ctx,
          );
          let content = multimodal ? JSON.stringify(multimodal) : extractedText;
          if (content) {
            queuedContents.push(content);
            structuredUserInputs.push(
              buildStructuredUserInputFromEvent(
                item.event,
                content,
                item.queuedAt,
              ),
            );
          }
        }

        // 清空队列
        queueManager.clearQueue(groupSessionId);

        if (queuedContents.length === 0) {
          queueManager.clearActiveTarget(groupSessionId);
          return;
        }

        // 不管是否有 activeTarget，都直接用队列消息构建新的 targetMessage
        // 已处理的消息不需要保留
        const firstItem = queue[0];
        const userName =
          firstItem.event.sender?.card ||
          firstItem.event.sender?.nickname ||
          String(firstItem.event.user_id);

        // 将所有队列消息合并，用换行分隔
        const mergedContent = queuedContents.join("\n");

        const targetMessage: TargetMessage = {
          userName,
          userId: firstItem.event.user_id || firstItem.event.sender?.user_id,
          userRole: firstItem.event.sender?.role || "member",
          content: mergedContent,
          messageId: firstItem.event.message_id,
          timestamp: Date.now(),
        };

        ctx.logger.info(
          `[Queue] group ${groupSessionId} batches ${queue.length} messages`,
        );

        // 清理旧的 activeTarget
        queueManager.clearActiveTarget(groupSessionId);

        const groupId = parseInt(groupSessionId.split(":")[1], 10);
        const botRole = await getBotRole(groupId, ctx, selfId);

        const toolCtx: ToolContext = buildToolContext({
          ctx,
          event: null,
          groupSessionId,
          groupId,
          userId: targetMessage.userId,
          config: cfg,
          aiService: aiService!,
          db,
          botRole,
          humanize,
          targetMessage,
          selfId,
        });

        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(selfId).nickname || "Bot";

        const { history } = await getGroupHistoryMessages(
          groupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          db,
          selfId,
          buildHistoryMediaOptions(aiInstance, cfg),
        );

        const contexts = await getHumanizeContexts(
          humanize,
          groupSessionId,
          targetMessage.content,
          targetMessage.userName,
          history,
          targetMessage.userId,
        );

        const { groupName, memberCount } = await getGroupInfoData(
          ctx,
          groupId,
          selfId,
        );

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
                botRole: toolCtx.botRole,
                aiService: aiService!,
                isGroup: true,
                memoryContext: contexts.memoryContext,
                topicContext: contexts.topicContext,
                expressionContext: contexts.expressionContext,
                replyContext: {
                  type: "comment",
                  targetUser: targetMessage.userName,
                  targetMessage: targetMessage.content,
                },
              },
              humanize,
              skillManager,
              {
                manager: groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: structuredUserInputs,
              },
            ),
          {
            userId: targetMessage.userId,
            groupId,
            label: "queue",
          },
        );
        if (!result) {
          queueManager.clearActiveTarget(groupSessionId);
          return;
        }

        await sendAIResponse(
          {
            ctx,
            groupId,
            messages: result.messages,
            config: cfg,
            sentIndices: toolCtx.sentMessageIndices,
            typoGenerator: humanize.typoGenerator,
          },
          selfId,
        );

        await sendEmoji(ctx, groupId, result.emojiPath, selfId);

        const now = Date.now();
        saveBotMessages(
          groupId,
          groupSessionId,
          result.messages,
          now,
          cfg,
          db,
          ctx,
          groupLastBotMessageTime,
          groupMessageCountAfterBot,
          selfId,
        );

        // 清理
        queueManager.clearActiveTarget(groupSessionId);
        sessionManager.touch(groupSessionId);

        ctx.logger.info(
          `[Queue] group ${groupSessionId} queue message processing is complete`,
        );
      } catch (err) {
        logger.error(err);
      }
    }

    /**
     * 处理 AI 聊天核心流程
     */
    async function processChat(
      e: any,
      cfg: ChatConfig,
      options?: {
        skipPlanner?: boolean;
        triggerReason?: string;
        appendToActive?: boolean;
      },
    ): Promise<void> {
      const isGroup = e.message_type === "group";
      const groupId: number | undefined = isGroup ? e.group_id : undefined;
      const userId: number = e.user_id || e.sender?.user_id;

      const groupSessionId = groupId
        ? `group:${groupId}`
        : `personal:${userId}`;
      const personalSessionId = `personal:${userId}`;

      if (isRateLimitBlocked()) {
        if (groupId) {
          queueManager.clearActiveTarget(groupSessionId);
        }
        return;
      }

      try {
        // 获取/创建会话
        sessionManager.getOrCreate(
          groupSessionId,
          groupId ? "group" : "personal",
          groupId ?? userId,
        );

        if (groupId) {
          sessionManager.getOrCreate(personalSessionId, "personal", userId);
        }

        // 提取内容
        // 检测引用内容
        const quotedInfo = await getQuotedContent(e, ctx);

        // 收集图片 URL（用于附加到消息）
        const imageUrls: string[] = [];

        // 从当前消息中提取图片 URL
        if (e.message) {
          for (const seg of e.message) {
            if (seg.type === "image" && (seg.url || seg.data?.url)) {
              imageUrls.push(seg.url || seg.data.url);
            }
          }
        }

        // 从引用消息中提取图片 URL
        if (quotedInfo?.imageUrl) {
          imageUrls.push(quotedInfo.imageUrl);
        }

        let messageContent: string;
        let extraContext = "";

        // 注入引用信息
        if (quotedInfo) {
          const parts: string[] = [];
          parts.push(
            `[Quoted message #${quotedInfo.messageId} from ${quotedInfo.senderName}: ${quotedInfo.content}]`,
          );
          if (quotedInfo.imageUrl) {
            parts.push("[Quoted message contains an image]");
          }
          extraContext = parts.join(" ");
        }

        // 获取文本
        const text = ctx.text(e) || "";
        if (extraContext) {
          messageContent = extraContext + " " + text;
        } else {
          messageContent = text;
        }

        if (options?.triggerReason) {
          messageContent = options.triggerReason + messageContent;
        }

        // 构建用户消息
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

        db.saveMessage(userMsg);

        // 表达学习
        humanize.expressionLearner.onMessage(groupSessionId, userMsg).then();

        // 话题跟踪
        humanize.topicTracker.onMessage(groupSessionId).then();

        // 加载群聊历史消息
        const rawHistory = groupId
          ? await getGroupHistory(
              groupId,
              ctx,
              cfg.historyCount,
              e.self_id,
              db,
              buildHistoryMediaOptions(aiInstance, cfg),
            )
          : [];

        // 转换为 ChatMessage 格式
        const history: ChatMessage[] = rawHistory.map((msg) => ({
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

        // 动作规划
        const botNickname =
          cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";

        if (!options?.skipPlanner) {
          const planResult = await humanize.actionPlanner.plan(
            groupSessionId,
            botNickname,
            history,
            text,
          );

          if (planResult.action === "complete") {
            ctx.logger.info(
              `[Action Planning] Session ${groupSessionId} End Conversation: ${planResult.reason}`,
            );
            // 清理活跃消息
            if (groupId) {
              queueManager.clearActiveTarget(groupSessionId);
            }
            return;
          }

          if (planResult.action === "wait") {
            ctx.logger.info(
              `[Action Planning] Session ${groupSessionId} Wait: ${planResult.reason}`,
            );
            // 清理活跃消息
            if (groupId) {
              queueManager.clearActiveTarget(groupSessionId);
            }
            return;
          }
        }

        // 获取 bot 角色和群信息
        const botRole = groupId
          ? await getBotRole(groupId, ctx, e.self_id)
          : "member";
        let groupName: string | undefined;
        let memberCount: number | undefined;

        if (groupId) {
          const groupInfo = await getGroupInfoData(
            ctx,
            groupId,
            e.self_id,
            e.group_name,
          );
          groupName = groupInfo.groupName;
          memberCount = groupInfo.memberCount;
        }

        // 记忆检索
        const senderName =
          e.sender?.card || e.sender?.nickname || String(userId);
        const contexts = await getHumanizeContexts(
          humanize,
          groupSessionId,
          text,
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

        // 保存到活跃消息映射
        if (groupId) {
          queueManager.setActiveTarget(groupSessionId, targetMessage);
        }

        const toolCtx: ToolContext = buildToolContext({
          ctx,
          event: e,
          groupSessionId,
          groupId,
          userId,
          config: cfg,
          aiService: aiService!,
          db,
          botRole,
          pendingImageUrls: imageUrls,
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
              humanize,
              skillManager,
              groupId
                ? {
                    manager: groupStructuredHistory,
                    ttlMs: cfg.groupStructuredHistoryTtlMs,
                    currentUserInputs: [
                      buildStructuredUserInputFromTarget(targetMessage),
                    ],
                  }
                : undefined,
            ),
          {
            userId,
            groupId,
            label: isGroup ? "group-chat" : "private-chat",
          },
        );

        if (!result) {
          if (groupId) {
            queueManager.clearActiveTarget(groupSessionId);
          }
          return;
        }

        if (groupId) {
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

          await sendEmoji(ctx, groupId, result.emojiPath, e.self_id);

          const now = Date.now();
          saveBotMessages(
            groupId,
            groupSessionId,
            result.messages,
            now,
            cfg,
            db,
            ctx,
            groupLastBotMessageTime,
            groupMessageCountAfterBot,
            e.self_id,
          );

          startCooldownTimer(groupSessionId, groupId, e.self_id);
        } else {
          const sentIndices = toolCtx.sentMessageIndices;
          if (result.messages.length > 0) {
            for (let i = 0; i < result.messages.length; i++) {
              if (sentIndices?.has(i)) continue;
              await sendMessage(
                ctx,
                undefined,
                userId,
                result.messages[i],
                cfg,
                humanize.typoGenerator,
                e.self_id,
              );
            }
          }

          if (result.emojiPath) {
            try {
              const emojiSegment = ctx.segment.image(
                `file://${result.emojiPath}`,
              );
              await e.reply([emojiSegment]);
            } catch (err) {
              ctx.logger.warn(`[Emoticon] Send failed: ${err}`);
            }
          }
        }

        sessionManager.touch(groupSessionId);
      } catch (err) {
        ctx.logger.error(`Chat processing failed: ${err}`);

        if (groupId) {
          queueManager.clearActiveTarget(groupSessionId);
        }
      }
    }

    ctx.handle("message", async (e: any) => {
      const cfg = await getConfig();
      if (!cfg.apiKey) return;

      const text = ctx.text(e) || "";
      const isGroup = e.message_type === "group";
      const groupId: number | undefined = isGroup ? e.group_id : undefined;
      const userId: number = e.user_id || e.sender?.user_id;

      // 忽略自身消息
      if (userId === e.self_id) return;

      // 处理命令
      // /空闲检查 调试指令
      if (text.startsWith("/空闲检查 ")) {
        const isOwner = ctx.isOwner?.(e) ?? false;
        if (!isOwner) {
          await e.reply("只有主人才能使用这个指令~");
          return;
        }
        const groupIdStr = text.replace("/空闲检查", "").trim();
        const targetGroupId = parseInt(groupIdStr, 10);
        if (!targetGroupId) {
          await e.reply("请指定群号，如：/空闲检查 123456");
          return;
        }

        // 手动触发空闲检测（跳过时间限制和消息数量限制）
        const groupSessionId = `group:${targetGroupId}`;
        try {
          // 获取配置
          const cfg = await getConfig();
          if (!cfg.apiKey) {
            await e.reply("未配置 API Key");
            return;
          }
          const now = Date.now();
          const botNickname =
            cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";

          ctx.logger.info(`[Debug] 手动触发空闲检测: 群 ${targetGroupId}`);

          const { history } = await getGroupHistoryMessages(
            targetGroupId,
            groupSessionId,
            ctx,
            cfg.historyCount,
            db,
            e.self_id,
            buildHistoryMediaOptions(aiInstance, cfg),
          );

          // 使用 planner 进行空闲检测
          const planResult = await humanize.actionPlanner.plan(
            groupSessionId,
            botNickname,
            history,
            "[Check if you want to answer the call]",
            true,
          );

          // 如果决定回复，执行真正的聊天
          if (planResult.action === "reply") {
            const targetMessage: TargetMessage = {
              userName: "系统",
              userId: 0,
              userRole: "member",
              content: "[No one in the group is talking? I'll answer!]",
              messageId: 0,
              timestamp: now,
            };

            const botRole = await getBotRole(targetGroupId, ctx, e.self_id);

            const toolCtx: ToolContext = buildToolContext({
              ctx,
              event: null,
              groupSessionId,
              groupId: targetGroupId,
              userId: 0,
              config: cfg,
              aiService: aiService!,
              db,
              botRole,
              humanize,
              targetMessage,
              selfId: e.self_id,
            });

            const plannerThoughts = `You stumbled upon some message in this group and decided to reply.
Suggestion:
- Quote messages from group friends appropriately (using [[[reply:message ID]]] format)
- Don't mention your intentions like "I'm here to answer" or something like a normal chat`;

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
                      aiService: aiService!,
                      isGroup: true,
                      plannerThoughts,
                      replyContext: {
                        type: "idle",
                      },
                    },
                    humanize,
                    skillManager,
                  ),
                {
                  groupId,
                  label: "idle-check",
                },
              );
              if (!result) {
                await e.reply(
                  `[空闲检测] 群 ${targetGroupId} 因限流被跳过`,
                );
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
              groupLastBotMessageTime,
              groupMessageCountAfterBot,
              e.self_id,
            );

            await e.reply(
              `[空闲检测] 群 ${targetGroupId} 已发送回复: ${planResult.reason}`,
            );
          } else {
            await e.reply(
              `[空闲检测] 群 ${targetGroupId}\n决定: ${planResult.action}\n原因: ${planResult.reason}`,
            );
          }
          return;
        } catch (err) {
          ctx.logger.error(`[Debug] 空闲检测失败: ${err}`);
          await e.reply(`[空闲检测] 失败: ${err}`);
          return;
        }
      }

      if (text === "/重置会话") {
        if (groupId) {
          const groupSessionId = `group:${groupId}`;
          sessionManager.resetBotMessages(groupSessionId);
          groupStructuredHistory.clear(groupSessionId);
          await e.reply("已清除本群会话中 AI 发送的消息~");
          return;
        }
        const personalSessionId = `personal:${userId}`;
        sessionManager.resetBotMessages(personalSessionId);
        groupStructuredHistory.clear(personalSessionId);
        await e.reply("已清除你的个人会话中 AI 发送的消息~");
        return;
      }

      // 群组黑白名单
      if (groupId && !isGroupAllowed(groupId, cfg)) return;

      // 媒体分析和收集（只处理新收到的群消息，不补扫历史）
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
                info: (message) => ctx.logger.info(message),
                warn: (message) => ctx.logger.warn(message),
                error: (message) => ctx.logger.error(message),
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
                processImage(
                  ai,
                  imageUrl,
                  cfg.multimodalWorkingModel,
                  db,
                  { runAIRequest: (request) =>
                    runWithRateLimitGuard(request, {
                      userId,
                      groupId,
                      label: "image-analysis",
                    }) },
                ).catch((err) => {
                  ctx.logger.error(`[image-analyzer] Failed to process: ${err}`);
                });
              }
            } else if (seg.type === "video" && mediaOptions) {
              const videoSources = [
                ...getSegmentSourceCandidates(seg),
                ...(await getVideoSourceCandidatesFromMessage(
                  bot,
                  e.message_id,
                ).catch(
                  (err) => {
                    ctx.logger.warn(
                      `[history-media] Failed to fetch video sources: ${err}`,
                    );
                    return [];
                  },
                )),
              ];
              if (videoSources.length > 0) {
                summarizeHistoryVideo(videoSources, mediaOptions).catch((err) => {
                  ctx.logger.error(
                    `[history-media] Failed to process video: ${err}`,
                  );
                });
              } else {
                ctx.logger.warn(
                  `[history-media] Video message ${e.message_id ?? "unknown"} has no source`,
                );
              }
            }
          }
        }

        if (mediaOptions) {
          for (const seg of e.message) {
            if (seg.type === "forward") {
              const forwardId = getForwardId(seg);
              if (forwardId) {
                summarizeHistoryForward(forwardId, mediaOptions).catch(
                  (err) => {
                    ctx.logger.error(
                      `[history-media] Failed to process forward: ${err}`,
                    );
                  },
                );
              }
            } else if (["xml", "json", "lightapp", "ark"].includes(seg.type)) {
              const cardData = getCardData(seg);
              if (cardData) {
                summarizeHistoryCard(cardData, mediaOptions).catch((err) => {
                  ctx.logger.error(
                    `[history-media] Failed to process card: ${err}`,
                  );
                });
              }
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
              .catch((err) => {
                ctx.logger.error(
                  `[history-media] Failed to process group notice: ${err}`,
                );
              });
          }
        }
      }

      // 检查是否 @ 了 bot
      const atBot = shouldTrigger(e, text, cfg, ctx);

      // 检查是否引用了 bot 消息
      const quotedBot = isGroup ? await isQuotingBot(e, ctx) : null;

      // 检查是否包含昵称
      const mentionedNickname =
        cfg.nicknames.length > 0 &&
        text.toLowerCase().includes(cfg.nicknames[0].toLowerCase());

      // 更新群的活动时间（仅群消息）
      if (isGroup && groupId) {
        const groupSessionId = `group:${groupId}`;
        groupLastActivityTime.set(groupSessionId, Date.now());
        const currentCount = groupMessageCount.get(groupSessionId) ?? 0;
        groupMessageCount.set(groupSessionId, currentCount + 1);

        // 更新 Bot 发言后的消息计数
        const currentBotCount =
          groupMessageCountAfterBot.get(groupSessionId) ?? 0;
        groupMessageCountAfterBot.set(groupSessionId, currentBotCount + 1);

        // 更新该群有哪些 bot
        let botsInGroup = groupBotsMapping.get(groupSessionId);
        if (!botsInGroup) {
          botsInGroup = new Set<number>();
          groupBotsMapping.set(groupSessionId, botsInGroup);
        }
        botsInGroup.add(e.self_id);

        // 检查是否在冷却期间，如果在则收集消息
        const cooldownUntil = groupCooldownUntil.get(groupSessionId) ?? 0;
        if (Date.now() < cooldownUntil) {
          // 在冷却期间，收集消息
          collectCooldownMessage(groupSessionId, groupId, e, text, atBot);
          return;
        }

        // 检查是否在动态延迟期间
        const delayQueue = dynamicDelayQueues.get(groupSessionId);
        if (delayQueue && Date.now() < delayQueue.delayUntil) {
          // 在动态延迟期间，收集 @bot 消息
          if (atBot && !isRateLimitBlocked()) {
            rateLimiter.recordInteraction(groupId, userId);
            collectDynamicDelayMessage(groupSessionId, e, text);
            ctx.logger.info(
              `[DynamicDelay] group ${groupId} received a @bot message during the delay, collected`,
            );
          }
          return;
        }
      }

      // 检查是否已在处理中
      const groupSessionId =
        isGroup && groupId ? `group:${groupId}` : undefined;

      // 群消息：检查群是否正在处理
      if (isGroup && groupId && groupSessionId) {
        if (processingSet.has(groupSessionId)) {
          // 群正在处理中，只有 @bot 或提到昵称的消息才加入队列
          if ((atBot || mentionedNickname) && !isRateLimitBlocked()) {
            queueManager.enqueue(groupSessionId, e, cfg);
            rateLimiter.recordInteraction(groupId, userId);
            ctx.logger.info(
              `[Queue] group ${groupId} is being processed, valid messages are added to the queue, current queue length: ${queueManager.getQueueLength(groupSessionId)}`,
            );
          }
          return;
        }

        // 标记群正在处理
        processingSet.add(groupSessionId);
      } else {
        // 私聊仍然基于用户
        const triggerKey = `personal:${userId}`;
        if (processingSet.has(triggerKey)) {
          return;
        }
        processingSet.add(triggerKey);
      }

      try {
        if (atBot) {
          if (!rateLimiter.canProcess(userId, groupId, text)) {
            return;
          }

          // 动态延迟检查
          if (
            isGroup &&
            groupId &&
            groupSessionId &&
            cfg.dynamicDelay?.enabled
          ) {
            rateLimiter.recordInteraction(groupId, userId);
            const delayInfo = rateLimiter.getDelayInfo(groupId);

            if (delayInfo.shouldDelay) {
              // 需要延迟，收集消息并启动计时器
              rateLimiter.record(userId, groupId, text);
              collectDynamicDelayMessage(groupSessionId, e, text);
              startDynamicDelayTimer(
                groupSessionId,
                groupId,
                delayInfo.delayMs,
                cfg,
                e.self_id,
              );
              return;
            }
          }

          rateLimiter.record(userId, groupId, text);
          await processChat(e, cfg, { skipPlanner: true });
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
            buildHistoryMediaOptions(aiInstance, cfg),
          );
          const botNickname =
            cfg.nicknames[0] || ctx.pickBot(e.self_id).nickname || "Bot";

          const planResult = await humanize.actionPlanner.plan(
            groupSessionId!,
            botNickname,
            history,
            text,
          );

          if (planResult.action === "reply") {
            if (!rateLimiter.canProcess(userId, groupId, text)) {
              return;
            }
            rateLimiter.record(userId, groupId, text);
            await processChat(e, cfg, { skipPlanner: true });
          }
          return;
        }
      } finally {
        if (isGroup && groupId && groupSessionId) {
          processingSet.delete(groupSessionId);
          // 处理队列中的消息
          await processQueuedMessages(groupSessionId, cfg, e.self_id);
        } else {
          processingSet.delete(`personal:${userId}`);
        }
      }
      // 没有触发任何条件，不回复
      return;
    });

    // ==================== 戳一戳处理 ====================
    ctx.handle("notice.group.poke" as any, async (e: any) => {
      if (e.target_id !== e.self_id) return;

      const cfg = await getConfig();
      if (!cfg.apiKey) return;

      const groupId = e.group_id;
      if (!groupId) return;
      if (!isGroupAllowed(groupId, cfg)) return;

      // 冷却检查
      const lastPoke = pokeCooldowns.get(groupId) ?? 0;
      if (Date.now() - lastPoke < POKE_COOLDOWN_MS) return;
      pokeCooldowns.set(groupId, Date.now());

      const groupSessionId = `group:${groupId}`;

      if (isRateLimitBlocked()) return;

      // 检查群是否正在处理，如果是则加入队列
      if (processingSet.has(groupSessionId)) {
        if (!isRateLimitBlocked()) {
          queueManager.enqueue(groupSessionId, e, cfg);
          ctx.logger.info(
            `[Queue] group ${groupId} Poke to join the queue, current queue length: ${queueManager.getQueueLength(groupSessionId)}`,
          );
        }
        return;
      }

      processingSet.add(groupSessionId);

      // 确保 session 存在
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

        // 构建戳一戳的 targetMessage
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
          buildHistoryMediaOptions(aiInstance, cfg),
        );

        const { groupName, memberCount } = await getGroupInfoData(
          ctx,
          groupId,
          e.self_id,
        );

        const toolCtx: ToolContext = buildToolContext({
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
          {
            userId,
            groupId,
            label: "poke",
          },
        );
        if (!result) {
          return;
        }

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
          groupLastBotMessageTime,
          groupMessageCountAfterBot,
          e.self_id,
        );

        await sendEmoji(ctx, groupId, result.emojiPath, e.self_id);

        sessionManager.touch(groupSessionId);
      } catch (err) {
        ctx.logger.error(`Poke 1 poke processing failed: ${err}`);
      } finally {
        processingSet.delete(groupSessionId);
      }
    });

    ctx.logger.info("聊天插件加载成功");

    // 清理函数
    return () => {
      db.close();
      rateLimiter.dispose();
      clearInterval(cleanupInterval);
      clearInterval(idleCheckInterval);
      processingSet.clear();
      pokeCooldowns.clear();
      groupLastActivityTime.clear();
      groupMessageCount.clear();
      groupLastBotMessageTime.clear();
      groupMessageCountAfterBot.clear();
      groupLastIdleCheckTime.clear();
      idleCheckProcessing.clear();
      for (const timer of cooldownTimeoutIds.values()) {
        clearTimeout(timer);
      }
      cooldownTimeoutIds.clear();
      groupCooldownUntil.clear();
      groupCooldownMessages.clear();
      ctx.logger.info("聊天插件已卸载");
    };
  },
});

export default chatPlugin;
