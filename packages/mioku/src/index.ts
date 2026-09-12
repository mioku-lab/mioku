import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntime as startMiokuRuntime } from "./start";
import { rootLogger } from "./logger";
import serviceManager from "./services/manager";
import { readMiokuConfig } from "./config";

import type { Logger } from "./logger";
import type { MiokuPlugin } from "./plugin/plugin";

export type { MiokuPlugin, MiokuContext } from "./plugin/plugin";
export type { EventMap } from "napcat-sdk";

export { definePlugin } from "./plugin/plugin";

export * from "./logger";
export { rootLogger as logger } from "./logger";
export * from "./driver";
export * from "./adapter";
export * from "./capabilities";
export * from "./runtime/bus";
export * from "./runtime/bots";
export * from "./runtime/context";
export * from "./runtime/lifecycle";
export * from "./runtime/mioku-context";
export * from "./runtime/runtime";
export * from "./runtime/types";
export * from "./loader";
export * from "./plugin/plugin";
export * from "./utils";
export * from "./actions";
export * from "./services/registry";
export * from "./services/define";
export * from "./services/builtin";
export * from "./services/manager";
export * from "./services/config";
export * from "./config";
export * from "./start";
export * from "./builtin";
export * from "./builtin/core/status";
export * from "./builtin/core/adapters";
export * from "./compat";

export { default as serviceManager } from "./services/manager";
export { registerPluginArtifacts } from "./runtime/plugin-artifacts";
export * from "./runtime/plugin-metadata";

export {
  registerServiceConfig,
  getServiceConfig,
  updateServiceConfig,
  getServiceConfigs,
  deleteServiceConfig,
} from "./services/config";

export type {
  MiokuService,
  MiokuRuntimeConfig,
  PackageJsonLike,
  PluginMetadata,
  ServiceMetadata,
  PluginPackageConfig,
  PluginHelp,
  CommandRole,
  AccessHook,
  AccessAction,
  AccessRuleEntry,
  AccessScopeConfig,
  AccessControlConfig,
  ConfigService,
  ScreenshotService,
  HelpService,
  WebUIService,
  AITool,
  AISkill,
  AIInstance,
  AIService,
  AIProtocol,
  AIModelCapability,
  AIThinkingLevel,
  AIModelRole,
  AIProviderConfig,
  AIModelDescriptor,
  AIInstanceInfo,
  ChatRuntime,
  TextMessage,
  MultimodalMessage,
  ToolCallRecord,
  CompleteOptions,
  CompleteResponse,
  SessionToolDefinition,
  SkillPermissionRole,
  MultimodalContentItem,
  ToolResultFollowup,
  ChatRuntimePromptInjection,
  ChatRuntimeGroupTarget,
  ChatRuntimePrivateTarget,
  ChatRuntimeSource,
  ChatRuntimeBaseOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeCollectedInfo,
  ChatRuntimeResult,
  AIUsageRange,
  AIUsageScope,
  AIUsageBotOption,
  AIUsageContext,
  AIUsageBreakdown,
  AIUsageFinalization,
  AIUsageSummary,
} from "./types";

export {
  TOOL_RESULT_FOLLOWUP_KEY,
  normalizeSkillPermissionRole,
  AI_THINKING_LEVELS,
  AI_GEMINI_THINKING_LEVELS,
  normalizeAIThinkingLevel,
} from "./types";

export {
  defineService,
  getService,
  requireService,
  hasService,
} from "./services/define";
export type { ServiceRef } from "./services/define";
export { Services } from "./services/builtin";
export type { BuiltinServiceRef } from "./services/builtin";

export interface MiokuStartOptions {
  cwd?: string;
  logger?: Logger;
  builtinPlugins?: readonly MiokuPlugin[];
}

export async function start(
  options: MiokuStartOptions = {},
): Promise<{ stop: (reason?: string) => Promise<void> }> {
  const { cwd = process.cwd() } = options;
  if (cwd) process.chdir(cwd);

  rootLogger.info("こんにちは..");
  rootLogger.info("---------------------------------------");
  rootLogger.info("----------  Mioku 正在启动 ------------");
  rootLogger.info("---------------------------------------");

  let miokuConfig: import("./types").MiokuRuntimeConfig = {};
  try {
    const cfg = readMiokuConfig();
    miokuConfig = cfg as unknown as import("./types").MiokuRuntimeConfig;
  } catch {
    miokuConfig = {};
  }
  rootLogger.info("o.O Miku 正在翻找服务..");
  await serviceManager.discoverServices(miokuConfig);

  const { stop: stopRuntime } = await startMiokuRuntime({
    cwd,
    logger: options.logger,
    builtinPlugins: options.builtinPlugins,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info(`收到 ${signal} 信号，正在关闭服务...`);
    const timer = setTimeout(() => {
      rootLogger.error("服务关闭超时，强制退出");
      process.exit(1);
    }, 15_000);
    timer.unref();
    try {
      await stopRuntime(signal);
    } finally {
      clearTimeout(timer);
    }
    rootLogger.info("Mioku 服务已完全关闭");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  installProcessErrorGuards();

  return {
    stop: (reason) => stopRuntime(reason),
  };
}

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const version: string = readVersion();

function installProcessErrorGuards(): void {
  if (process.listenerCount("unhandledRejection") === 0) {
    process.on("unhandledRejection", (reason) => {
      const detail =
        reason instanceof Error ? reason.stack ?? reason.message : reason;
      rootLogger.error(`[unhandledRejection] ${String(detail)}`);
    });
  }
  if (process.listenerCount("uncaughtException") === 0) {
    process.on("uncaughtException", (err) => {
      rootLogger.error(
        `[uncaughtException] ${err.stack ?? err.message ?? String(err)}`,
      );
    });
  }
}

export {
  getDataDir,
  getPluginDataDir,
  getServiceDataDir,
  getConfigDir,
  getPluginConfigDir,
  getServiceConfigDir,
  ensureDataDir,
} from "./internal/data-paths";

export {
  defineState,
  hasPluginState,
  getPluginRuntimeState,
  setPluginRuntimeState,
  resetPluginRuntimeState,
  getAllPluginRuntimeStates,
} from "./runtime/plugin-state";
export type { PluginStateRef } from "./runtime/plugin-state";

export {
  resolveCommand,
  commandExists,
  buildSpawnPlan,
  runCommand,
  runCommandInherit,
} from "./internal/exec";
export type { RunCommandResult, SpawnPlan } from "./internal/exec";