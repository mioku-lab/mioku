/**
 * Mioku - Plugin framework extended from mioki
 *
 * Main entry point for the mioku npm package
 */

import pluginManager from "./core/plugin-manager";
import serviceManager from "./core/service-manager";
import { registerPluginArtifacts } from "./core/plugin-artifact-registry";
import * as fs from "fs";
import * as path from "path";
import { existsSync, mkdirSync } from "fs";
import {
  DEFAULT_RUNTIME_PLUGINS_DIR,
  prepareRuntimePluginLinks,
} from "./core/plugin-linker";
import { setMiokuLogger } from "./core/logger";

// Re-export mioki types for convenience
export type { MiokiPlugin, MiokiContext } from "mioki";

export function definePlugin<T extends import("mioki").MiokiPlugin>(
  plugin: T,
): T {
  return plugin;
}

// Core functionality
export { default as pluginManager } from "./core/plugin-manager";
export { default as serviceManager } from "./core/service-manager";
export { registerPluginArtifacts } from "./core/plugin-artifact-registry";

// Types from types.ts
export type {
  MiokuService,
  PluginMetadata,
  ServiceMetadata,
  PluginPackageConfig,
  PluginHelp,
  CommandRole,
} from "./types";

// Service types from service-types.ts
export type {
  ConfigService,
  ScreenshotService,
  HelpService,
  WebUIService,
  AITool,
  AISkill,
  AIInstance,
  AIService,
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
  AIUsageContext,
  AIUsageBreakdown,
  AIUsageFinalization,
  AIUsageSummary,
} from "./service-types";

export { TOOL_RESULT_FOLLOWUP_KEY } from "./service-types";

/**
 * Start options for Mioku
 */
export interface MiokuStartOptions {
  cwd?: string;
}

/**
 * Start Mioku with plugin and service discovery
 */
export async function start(options: MiokuStartOptions = {}): Promise<void> {
  const { cwd = process.cwd() } = options;

  if (cwd) {
    process.chdir(cwd);
  }

  const { start: startMioki, logger, botConfig } = await import("mioki");
  setMiokuLogger(logger);

  // Read mioku config from package.json (mioki field contains merged config)
  const packageJsonPath = path.join(process.cwd(), "package.json");
  let miokuConfig: any = {};
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    // mioku-specific config lives in the same mioki field
    miokuConfig = pkg.mioki || {};
  }

  logger.info("こんにちは..");
  logger.info("---------------------------------------");
  logger.info("----------  Mioku 正在启动 ------------");
  logger.info("---------------------------------------");

  // Ensure required directories exist
  const requiredDirs = ["data", "config", "temp"];
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  logger.info("O.o Miku 正在翻找插件..");
  const discoveredPlugins = await pluginManager.discoverPlugins(miokuConfig);
  logger.info(`O.o 共发现 ${discoveredPlugins.length} 个插件: ${discoveredPlugins.map(p => p.name).join(", ")}`);

  const runtimePluginsDir = path.resolve(
    process.cwd(),
    DEFAULT_RUNTIME_PLUGINS_DIR,
  );
  const linkedPluginNames = await prepareRuntimePluginLinks(
    discoveredPlugins,
    runtimePluginsDir,
  );
  botConfig.plugins_dir = DEFAULT_RUNTIME_PLUGINS_DIR;

  logger.info("o.O Miku 正在翻找服务..");
  await serviceManager.discoverServices(miokuConfig);

  const requiredServices = pluginManager.collectRequiredServices();
  const missingServices =
    await serviceManager.checkMissingServices(requiredServices);

  if (missingServices.length > 0) {
    logger.warn(`发现缺失服务: ${missingServices.join(", ")}`);
  }

  // Merge discovered plugin names into botConfig.plugins so mioki loads them
  const discoveredPluginNames = linkedPluginNames;
  for (const name of discoveredPluginNames) {
    if (!botConfig.plugins.includes(name)) {
      botConfig.plugins.push(name);
    }
  }

  await startMioki({ cwd });
}

// Version
export const version = "1.0.0";

// Data path utilities
export {
  getDataDir,
  getPluginDataDir,
  getServiceDataDir,
  getConfigDir,
  getPluginConfigDir,
  getServiceConfigDir,
  ensureDataDir,
} from "./core/data-paths";

// Plugin runtime state
export {
  getPluginRuntimeState,
  setPluginRuntimeState,
  resetPluginRuntimeState,
} from "./core/plugin-runtime-state";
