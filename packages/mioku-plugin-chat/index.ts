import { definePlugin, type MiokuContext } from "mioku";
import type { AIInstance, AIModelRole, AIService } from "mioku";
import type { AudioServiceApi } from "mioku-service-audio";
import { getPluginRuntimeState, getService, Services } from "mioku";
import type {
  ChatConfig,
  ChatMessage,
  ChatGroupsFile,
  TargetMessage,
} from "./types";
import { initDatabase } from "./db";
import { SessionManager } from "./manage/session";
import { RateLimiter } from "./manage/rate-limiter";
import { runChat } from "./core/chat-engine";
import { HumanizeEngine } from "./humanize";
import { SkillSessionManager } from "./manage/skill-session";
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
import { CooldownManager } from "./manage/cooldown";
import { IdleCheckManager } from "./manage/idle-check";
import { QueueProcessor } from "./manage/queue-processor";
import { SessionTurnScheduler } from "./manage/session-turn-scheduler";
import { ChatDatabaseCleanup, DEFAULT_CLEANUP_CONFIG } from "./manage/cleanup";
import {
  GroupStructuredHistoryManager,
  buildStructuredUserMessages,
  buildStructuredUserInputFromTarget,
} from "./manage/group-structured-history";
import { BASE_CONFIG } from "./configs/base";
import { SETTINGS_CONFIG } from "./configs/settings";
import { PERSONALIZATION_CONFIG } from "./configs/personalization";
import { DEFAULT_GROUPS_CONFIG } from "./configs/groups";
import { RateLimitGuard } from "./manage/rate-limit-guard";
import { createChatRuntime } from "./runtime/chat-runtime";
import { createMessageHandler } from "./handlers/message";
import { createPokeHandler } from "./handlers/poke";
import { buildHistoryMediaOptions } from "./core/media/segment";
import type { ChatConfigProvider } from "./humanize";
import type { ChatPluginContext, ChatHandlerState } from "./context";
import { mergeGroupOverrides } from "./utils/group-config";
import {
  mergeChatConfig,
  normalizeIdList,
  normalizeMediaAnalysisBlacklist,
} from "./utils/config";

function resolveRoleInstances(aiService: AIService): {
  main: AIInstance;
  work: AIInstance;
  vision: AIInstance;
  models: { main: string; working: string; vision: string };
  isMultimodal: boolean;
} | null {
  const getByRole = (role: AIModelRole) =>
    aiService.getInstanceByRole?.(role) ?? aiService.get?.(role) ?? undefined;

  const main =
    getByRole("main") ?? aiService.getDefault?.() ?? aiService.get?.("main");
  if (!main) return null;

  const work = getByRole("working") ?? aiService.get?.("work") ?? main;
  const vision = getByRole("vision") ?? aiService.get?.("vision") ?? work;

  const bindings = aiService.getRoleBindings?.() ?? {
    main: undefined,
    working: undefined,
    vision: undefined,
  };
  const instances = aiService.listInstances?.() ?? [];
  const findModel = (role: AIModelRole, fallbackInstance: AIInstance) => {
    const full = bindings[role];
    if (full && full.includes("/")) return full.split("/").slice(1).join("/");
    const info = instances.find(
      (item) => item.role === role || item.name === role,
    );
    if (info?.modelId) return info.modelId;
    const anyInfo = instances.find(
      (item) => item.name === (fallbackInstance as any).name,
    );
    return anyInfo?.modelId || "";
  };

  const mainModel = findModel("main", main);
  const workingModel = findModel("working", work) || mainModel;
  const visionModel = findModel("vision", vision) || workingModel;

  const models = aiService.listModels?.() ?? [];
  const visionDesc =
    models.find((item) => item.id === bindings.vision) ||
    models.find((item) => item.modelId === visionModel);
  const isMultimodal =
    visionDesc?.capabilities?.includes("vision") ?? Boolean(visionModel);

  return {
    main,
    work,
    vision,
    models: {
      main: mainModel,
      working: workingModel,
      vision: visionModel,
    },
    isMultimodal,
  };
}

export default definePlugin({
  name: "chat",
  async setup(ctx: MiokuContext) {
    ctx.logger.info("聊天插件正在初始化...");

    const aiService = getService(ctx, Services.AI);
    const configService = getService(ctx, Services.Config);
    const screenshotService = getService(ctx, Services.Screenshot);
    const audioService = ctx.services.audio as AudioServiceApi | undefined;
    let warnedMarkdownScreenshotUnavailable = false;
    if (!audioService) {
      ctx.logger.warn("聊天插件检测到 audio 服务未安装 语音消息将不会发出");
    }

    if (configService) {
      await configService.registerConfig("chat", "base", BASE_CONFIG);
      await configService.registerConfig("chat", "settings", SETTINGS_CONFIG);
      await configService.registerConfig(
        "chat",
        "personalization",
        PERSONALIZATION_CONFIG,
      );
      await configService.registerConfig(
        "chat",
        "groups",
        DEFAULT_GROUPS_CONFIG,
      );
    }

    let cachedBaseConfig: ChatConfig | null = null;
    let cachedGroupsConfig: ChatGroupsFile | null = null;
    let roleModels = {
      main: "",
      working: "",
      vision: "",
    };
    let roleIsMultimodal = true;

    const buildGlobalConfig = async (): Promise<ChatConfig> => {
      if (!configService) {
        return mergeChatConfig(
          mergeChatConfig(
            mergeChatConfig({} as ChatConfig, BASE_CONFIG),
            SETTINGS_CONFIG,
          ),
          PERSONALIZATION_CONFIG,
        );
      }
      const base = (await configService.getConfig("chat", "base")) ?? {};
      const settings =
        (await configService.getConfig("chat", "settings")) ?? {};
      const personalization =
        (await configService.getConfig("chat", "personalization")) ?? {};
      const mergedDefaults = mergeChatConfig(
        mergeChatConfig(
          mergeChatConfig({} as ChatConfig, BASE_CONFIG),
          SETTINGS_CONFIG,
        ),
        PERSONALIZATION_CONFIG,
      );
      const merged = mergeChatConfig(
        mergeChatConfig(
          mergeChatConfig(mergedDefaults, settings),
          personalization,
        ),
        base,
      ) as ChatConfig;

      if (typeof merged.stream !== "boolean") merged.stream = true;
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
      merged.mediaAnalysisBlacklistUsers = normalizeMediaAnalysisBlacklist(
        merged as Record<string, any>,
      );
      delete (merged as any).imageAnalysisBlacklistUsers;

      merged.model = roleModels.main || merged.model || "";
      merged.workingModel =
        roleModels.working || merged.workingModel || merged.model;
      merged.multimodalWorkingModel =
        roleModels.vision ||
        merged.multimodalWorkingModel ||
        merged.workingModel;
      merged.isMultimodal = roleIsMultimodal;
      if (!roleIsMultimodal) merged.enableMediaRecognition = false;
      if (!merged.apiKey) merged.apiKey = "__ai_service__";

      return merged;
    };

    const refreshGroupsCache = async (): Promise<void> => {
      if (!configService) {
        cachedGroupsConfig = DEFAULT_GROUPS_CONFIG;
        return;
      }
      const raw = await configService.getConfig("chat", "groups");
      cachedGroupsConfig =
        raw &&
        typeof raw === "object" &&
        raw.groups &&
        typeof raw.groups === "object"
          ? (raw as ChatGroupsFile)
          : DEFAULT_GROUPS_CONFIG;
    };

    const refreshBaseCache = async (): Promise<void> => {
      cachedBaseConfig = await buildGlobalConfig();
    };

    await refreshBaseCache();
    await refreshGroupsCache();

    if (configService) {
      configService.onConfigChange("chat", "base", () => {
        refreshBaseCache().catch((err) =>
          ctx.logger.error(`刷新 chat/base 缓存失败: ${err}`),
        );
      });
      configService.onConfigChange("chat", "settings", () => {
        refreshBaseCache().catch((err) =>
          ctx.logger.error(`刷新 chat/settings 缓存失败: ${err}`),
        );
      });
      configService.onConfigChange("chat", "personalization", () => {
        refreshBaseCache().catch((err) =>
          ctx.logger.error(`刷新 chat/personalization 缓存失败: ${err}`),
        );
      });
      configService.onConfigChange("chat", "groups", () => {
        refreshGroupsCache().catch((err) =>
          ctx.logger.error(`刷新 chat/groups 缓存失败: ${err}`),
        );
      });
    }

    const configProvider: ChatConfigProvider = (groupId?: number) => {
      const base = cachedBaseConfig;
      if (!base) return PERSONALIZATION_CONFIG as unknown as ChatConfig;
      if (groupId === undefined) return base;
      const overrides = cachedGroupsConfig?.groups?.[String(groupId)];
      return mergeGroupOverrides(base, overrides);
    };

    const getConfig = async (groupId?: number): Promise<ChatConfig> => {
      if (!cachedBaseConfig) await refreshBaseCache();
      return configProvider(groupId);
    };

    if (!aiService) {
      ctx.logger.error("聊天插件需要 AI 服务，但 AI 服务不可用");
      return;
    }

    let resolved = resolveRoleInstances(aiService);

    if (!resolved) {
      const earlyConfig = configProvider();
      const legacyApiUrl = String((earlyConfig as any).apiUrl || "").trim();
      const legacyApiKey = String((earlyConfig as any).apiKey || "").trim();
      const legacyModel = String((earlyConfig as any).model || "").trim();
      if (legacyApiUrl && legacyApiKey && legacyApiKey !== "__ai_service__") {
        ctx.logger.warn(
          "未检测到 AI 角色绑定，回退到 chat/base 遗留 apiUrl/apiKey 创建实例",
        );
        await aiService.create({
          name: "main",
          apiUrl: legacyApiUrl,
          apiKey: legacyApiKey,
          modelType: "multimodal",
          model: legacyModel || "default",
        });
        await aiService.create({
          name: "work",
          apiUrl: legacyApiUrl,
          apiKey: legacyApiKey,
          modelType: "text",
          model: String(
            (earlyConfig as any).workingModel || legacyModel || "default",
          ),
        });
        await aiService.create({
          name: "vision",
          apiUrl: legacyApiUrl,
          apiKey: legacyApiKey,
          modelType: "multimodal",
          model: String(
            (earlyConfig as any).multimodalWorkingModel ||
              legacyModel ||
              "default",
          ),
        });
        aiService.setDefault("main");
        aiService.setRoleBinding?.(
          "main",
          `runtime-main/${legacyModel || "default"}`,
        );
        aiService.setRoleBinding?.(
          "working",
          `runtime-work/${String((earlyConfig as any).workingModel || legacyModel || "default")}`,
        );
        aiService.setRoleBinding?.(
          "vision",
          `runtime-vision/${String((earlyConfig as any).multimodalWorkingModel || legacyModel || "default")}`,
        );
        resolved = resolveRoleInstances(aiService);
      }
    }

    if (!resolved) {
      ctx.logger.error(
        "未配置 AI 提供商/主模型，请在 WebUI AI 设置中配置提供商并绑定主模型",
      );
      return;
    }

roleModels = resolved.models;
    roleIsMultimodal = resolved.isMultimodal;
    await refreshBaseCache();

    const mainAIInstance = resolved.main;
    const workAIInstance = resolved.work;
    const visionAIInstance = resolved.vision;
    if (!aiService.getDefault()) {
      aiService.setDefault("main");
    }

    const registerPersona = (persona: string) => {
      mainAIInstance.registerPrompt("persona", persona);
      workAIInstance.registerPrompt("persona", persona);
    };
    registerPersona(String(configProvider().persona ?? ""));
    if (configService) {
      configService.onConfigChange("chat", "personalization", async () => {
        try {
          const p = await configService.getConfig("chat", "personalization");
          registerPersona(String(p?.persona ?? ""));
        } catch (err) {
          ctx.logger.error(`更新 persona 提示词失败: ${err}`);
        }
      });
    }

    const db = await initDatabase();
    const sessionManager = new SessionManager(db, configProvider().maxSessions);
    const queueManager = new MessageQueueManager();
    const rateLimiter = new RateLimiter({
      maxTriggersPerWindow: 5,
      windowMs: 60_000,
      dedupWindowMs: 30_000,
      groupCooldownMs: 1_000,
    });
    rateLimiter.setConfigProvider(configProvider);
    const skillManager = new SkillSessionManager();

    rateLimiter.setQueueLengthGetter((groupId: number) =>
      queueManager.getQueueLength(`group:${groupId}`),
    );

    const humanize = new HumanizeEngine(workAIInstance, db, configProvider);
    await humanize.init();

    const pokeCooldowns = new Map<number, number>();
    const processingSet = new Set<string>();
    const sessionTurnScheduler = new SessionTurnScheduler();
    const groupStructuredHistory = new GroupStructuredHistoryManager();
    const rateLimitGuard = new RateLimitGuard(rateLimiter, ctx.logger);
    const runWithRateLimitGuard = rateLimitGuard.run.bind(rateLimitGuard);

    const getAIInstance = (
      role: AIModelRole = "main",
    ): AIInstance | undefined => {
      if (role === "working") {
        return aiService.getInstanceByRole?.("working") ?? workAIInstance;
      }
      if (role === "vision") {
        return aiService.getInstanceByRole?.("vision") ?? visionAIInstance;
      }
      return aiService.getInstanceByRole?.("main") ?? mainAIInstance;
    };

    const pluginCtx = {
      ctx,
      defaultConfig: configProvider(),
      configProvider,
      getConfig,
      db,
      aiInstance: mainAIInstance,
      workAIInstance,
      visionAIInstance,
      getAIInstance,
      aiService,
      humanize,
      sessionManager,
      skillManager,
      rateLimiter,
      queueManager,
      groupStructuredHistory,
      cooldownManager: undefined as unknown as CooldownManager,
      idleCheckManager: undefined as unknown as IdleCheckManager,
      queueProcessor: undefined as unknown as QueueProcessor,
      sessionTurnScheduler,
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
      audioService,
      startCooldownTimer: (
        groupSessionId: string,
        groupId: number,
        selfId: number,
      ) => cooldownManager.startCooldownTimer(groupSessionId, groupId, selfId),
      async recordGroupMessageForLearning(
        userMsg: ChatMessage,
        groupSessionId: string,
      ) {
        db.saveMessage(userMsg);
        await Promise.all([
          humanize.expressionLearner.onMessage(userMsg),
          humanize.topicTracker.onMessage(groupSessionId),
        ]);
        if (userMsg.groupId) {
          const ttlMs = configProvider(
            userMsg.groupId,
          ).groupStructuredHistoryTtlMs;
          groupStructuredHistory.append(
            groupSessionId,
            buildStructuredUserMessages([
              buildStructuredUserInputFromTarget(
                userMsg as unknown as TargetMessage,
              ),
            ]),
            ttlMs,
          );
        }
      },
    } as ChatPluginContext;

    const idleCheckManager = new IdleCheckManager(pluginCtx);
    pluginCtx.idleCheckManager = idleCheckManager;
    const cooldownManager = new CooldownManager(pluginCtx);
    pluginCtx.cooldownManager = cooldownManager;
    const queueProcessor = new QueueProcessor(pluginCtx);
    pluginCtx.queueProcessor = queueProcessor;

    const cleanupInterval = setInterval(
      () => skillManager.cleanup(),
      10 * 60_000,
    );
    const dbCleanup = new ChatDatabaseCleanup(
      db,
      configProvider().retention ?? DEFAULT_CLEANUP_CONFIG,
    );
    dbCleanup.start();
    idleCheckManager.start();

    const handlerState: ChatHandlerState = {
      getConfig,
      runtimeState: {
        isRateLimitBlocked: () => rateLimitGuard.isBlocked(),
        processingSet,
      },
      matchMessageCommands: (
        getPluginRuntimeState("core") as
          | {
              matchMessageCommands?: (
                text: string,
              ) => Array<{ plugin: string; command: string }>;
            }
          | undefined
      )?.matchMessageCommands,
      pokeCooldowns,
    };

    const runtime = createChatRuntime(pluginCtx, getConfig);
    aiService.registerChatRuntime(runtime);

    ctx.handle("message", createMessageHandler(pluginCtx, handlerState));
    ctx.handle("notice.group.poke", createPokeHandler(pluginCtx, handlerState));

    ctx.logger.info(
      `聊天插件加载成功 (main=${roleModels.main || "?"}, work=${roleModels.working || "?"}, vision=${roleModels.vision || "?"})`,
    );

    return () => {
      idleCheckManager.dispose();
      cooldownManager.dispose();
      queueProcessor.dispose();
      sessionTurnScheduler.dispose();
      queueManager.dispose();
      clearInterval(cleanupInterval);
      dbCleanup.stop();
      rateLimiter.dispose();
      processingSet.clear();
      pokeCooldowns.clear();
      db.close();
      ctx.logger.info("聊天插件已卸载");
    };
  },
});
