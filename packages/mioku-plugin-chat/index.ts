import { definePlugin, type MiokuContext } from "mioku";
import type { AIInstance, AIModelRole } from "mioku";
import type { AudioServiceApi } from "mioku-service-audio";
import { getPluginRuntimeState, getService, Services } from "mioku";
import { initDatabase } from "./db";
import { HumanizeEngine } from "./humanize";
import { SessionManager } from "./manage/session";
import { RateLimiter } from "./manage/rate-limiter";
import { RateLimitGuard } from "./manage/rate-limit-guard";
import { SkillSessionManager } from "./manage/skill-session";
import { MessageQueueManager } from "./utils/queue";
import { CooldownManager } from "./manage/cooldown";
import { GroupEventPerception } from "./manage/group-events";
import { QueueProcessor } from "./manage/queue-processor";
import { SessionTurnScheduler } from "./manage/session-turn-scheduler";
import { ChatDatabaseCleanup, DEFAULT_CLEANUP_CONFIG } from "./manage/cleanup";
import { GroupStructuredHistoryManager } from "./manage/group-structured-history";
import {
  runCooldownReview,
  runDynamicDelayBatch,
  runQueuedMessages,
} from "./core/turn/batch-turns";
import { createChatConfigStore } from "./runtime/config-store";
import {
  createLegacyRoleInstances,
  resolveRoleInstances,
} from "./runtime/ai-roles";
import { createChatRuntime } from "./runtime/chat-runtime";
import { createMessageHandler } from "./handlers/message";
import { createGroupEventHandler } from "./handlers/group-events";
import { createPokeHandler } from "./handlers/poke";
import { registerChatCommands } from "./commands";
import type { ChatPluginContext, ChatHandlerState } from "./context";
import { mainModelSupportsVision } from "./utils/model";
import { readField } from "./utils/record";

export { resolveRoleInstances };

type MatchMessageCommands = NonNullable<ChatHandlerState["matchMessageCommands"]>;

/** core 插件暴露的命令匹配器，用来跳过命令消息 */
function coreCommandMatcher(): MatchMessageCommands | undefined {
  const state = getPluginRuntimeState<{ matchMessageCommands?: unknown }>(
    "core",
  );
  const matcher = state?.matchMessageCommands;
  return isCommandMatcher(matcher) ? matcher : undefined;
}

function isCommandMatcher(value: unknown): value is MatchMessageCommands {
  return typeof value === "function";
}

export default definePlugin({
  name: "chat",
  async setup(ctx: MiokuContext) {
    ctx.logger.info("聊天插件正在初始化...");

    const aiService = getService(ctx, Services.AI);
    const audioService = ctx.services.audio as AudioServiceApi | undefined;
    if (!audioService) {
      ctx.logger.warn("聊天插件检测到 audio 服务未安装 语音消息将不会发出");
    }

    const configStore = await createChatConfigStore(ctx);
    const { provider: configProvider } = configStore;

    if (!aiService) {
      ctx.logger.error("聊天插件需要 AI 服务，但 AI 服务不可用");
      return () => configStore.dispose();
    }

    let resolved = resolveRoleInstances(aiService);
    if (!resolved && (await createLegacyRoleInstances(aiService, configProvider()))) {
      ctx.logger.warn(
        "未检测到 AI 角色绑定，回退到 chat/base 遗留 apiUrl/apiKey 创建实例",
      );
      resolved = resolveRoleInstances(aiService);
    }
    if (!resolved) {
      ctx.logger.error(
        "未配置 AI 提供商/主模型，请在 WebUI AI 设置中配置提供商并绑定主模型",
      );
      return () => configStore.dispose();
    }

    const { models: roleModels, isMultimodal } = resolved;
    if (resolved.visionFromMain) {
      ctx.logger.warn(
        `vision 角色绑定的模型不能看图，媒体识别改用主模型 ${roleModels.main}`,
      );
    } else if (!isMultimodal) {
      ctx.logger.warn(
        "没有绑定能看图的模型，群聊媒体识别已关闭（请在 AI 设置里给 vision 角色绑定一个支持视觉的模型）",
      );
    }
    await configStore.applyRoleModels(roleModels, isMultimodal);

    const { main: mainAI, work: workAI, vision: visionAI } = resolved;
    if (!aiService.getDefault()) aiService.setDefault("main");

    const registerPersona = (persona: string) => {
      mainAI.registerPrompt("persona", persona);
      workAI.registerPrompt("persona", persona);
    };
    registerPersona(String(configProvider().persona ?? ""));
    configStore.watch("personalization", async () => {
      const raw = await configStore.readRaw("personalization");
      registerPersona(String(readField(raw, "persona") ?? ""));
    });

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
    rateLimiter.setQueueLengthGetter((groupId: string) =>
      queueManager.getQueueLength(`group:${groupId}`),
    );

    const humanize = new HumanizeEngine(workAI, db, configProvider);
    await humanize.init();

    const pokeCooldowns = new Map<string, number>();
    const processingSet = new Set<string>();
    const skillManager = new SkillSessionManager();
    const sessionTurnScheduler = new SessionTurnScheduler();
    const rateLimitGuard = new RateLimitGuard(rateLimiter, ctx.logger);

    const getAIInstance = (
      role: AIModelRole = "main",
    ): AIInstance | undefined => {
      if (role === "working") {
        return aiService.getInstanceByRole?.("working") ?? workAI;
      }
      if (role === "vision") {
        return aiService.getInstanceByRole?.("vision") ?? visionAI;
      }
      return aiService.getInstanceByRole?.("main") ?? mainAI;
    };

    const pluginCtx: ChatPluginContext = {
      ctx,
      configProvider,
      getConfig: configStore.get,
      db,
      aiService,
      aiInstance: mainAI,
      visionAIInstance: visionAI,
      getAIInstance,
      humanize,
      audioService,
      sessionManager,
      skillManager,
      rateLimiter,
      queueManager,
      groupStructuredHistory: new GroupStructuredHistoryManager(),
      groupEvents: new GroupEventPerception(db),
      cooldownManager: new CooldownManager({
        scheduler: sessionTurnScheduler,
        configProvider,
        logger: ctx.logger,
        onExpire: (batch) => runCooldownReview(pluginCtx, batch),
      }),
      queueProcessor: new QueueProcessor({
        scheduler: sessionTurnScheduler,
        rateLimiter,
        logger: ctx.logger,
        onDynamicDelay: (batch) => runDynamicDelayBatch(pluginCtx, batch),
        onQueued: (sessionId, selfId) =>
          runQueuedMessages(pluginCtx, sessionId, selfId),
      }),
      sessionTurnScheduler,
      runWithRateLimitGuard: rateLimitGuard.run.bind(rateLimitGuard),
    };

    const skillCleanupTimer = setInterval(
      () => skillManager.cleanup(),
      10 * 60_000,
    );
    const dbCleanup = new ChatDatabaseCleanup(
      db,
      configProvider().retention ?? DEFAULT_CLEANUP_CONFIG,
    );
    dbCleanup.start();

    const handlerState: ChatHandlerState = {
      getConfig: configStore.get,
      runtimeState: {
        isRateLimitBlocked: () => rateLimitGuard.isBlocked(),
        processingSet,
      },
      matchMessageCommands: coreCommandMatcher(),
      pokeCooldowns,
    };

    aiService.registerChatRuntime(createChatRuntime(pluginCtx));
    registerChatCommands(pluginCtx);

    ctx.handle("message", createMessageHandler(pluginCtx, handlerState));
    ctx.handle("notice", createGroupEventHandler(pluginCtx));
    ctx.handle("notice.group.poke", createPokeHandler(pluginCtx, handlerState));

    ctx.logger.info(
      `聊天插件加载成功 (main=${roleModels.main || "?"}${mainModelSupportsVision(aiService, roleModels.main) ? "" : " 无视觉，图片交给视觉模型描述"}, work=${roleModels.working || "?"}, vision=${roleModels.vision || "?"}${isMultimodal ? "" : "（不能看图，媒体识别已关闭）"})`,
    );

    return () => {
      configStore.dispose();
      aiService.removeChatRuntime();
      pluginCtx.groupEvents.dispose();
      pluginCtx.cooldownManager.dispose();
      pluginCtx.queueProcessor.dispose();
      sessionTurnScheduler.dispose();
      queueManager.dispose();
      clearInterval(skillCleanupTimer);
      dbCleanup.stop();
      rateLimiter.dispose();
      processingSet.clear();
      pokeCooldowns.clear();
      db.close();
      ctx.logger.info("聊天插件已卸载");
    };
  },
});
