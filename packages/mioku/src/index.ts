/**
 * Mioku - Plugin framework extended from mioki
 *
 * Main entry point for the mioku npm package
 */

import { start as startMioki, logger, botConfig } from "mioki";
import pluginManager from "./core/plugin-manager";
import serviceManager from "./core/service-manager";
import { registerPluginArtifacts } from "./core/plugin-artifact-registry";
import * as fs from "fs";
import * as path from "path";
import { existsSync, mkdirSync } from "fs";

// Re-export mioki types for convenience
export type { MiokiPlugin, MiokiContext } from "mioki";

export { definePlugin } from "mioki";

// Core functionality
export { default as pluginManager } from "./core/plugin-manager";
export { default as serviceManager } from "./core/service-manager";
export { registerPluginArtifacts } from "./core/plugin-artifact-registry";

// Services (from src/services/)
export { default as configService } from "./services/config";
export { default as aiService } from "./services/ai";
export { default as screenshotService } from "./services/screenshot";

// Plugins (from src/plugins/)
export { default as bootPlugin } from "./plugins/boot";
export { default as helpPlugin } from "./plugins/help";
export { default as chatPlugin } from "./plugins/chat";

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
} from "./service-types";

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

  // Read mioku config from package.json (mioki field contains merged config)
  const packageJsonPath = path.join(cwd, "package.json");
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

  logger.info("o.O Miku 正在翻找服务..");
  await serviceManager.discoverServices(miokuConfig);

  const requiredServices = pluginManager.collectRequiredServices();
  const missingServices =
    await serviceManager.checkMissingServices(requiredServices);

  if (missingServices.length > 0) {
    logger.warn(`发现缺失服务: ${missingServices.join(", ")}`);
  }

  // Merge discovered plugin names into botConfig.plugins so mioki loads them
  const discoveredPluginNames = discoveredPlugins.map((p) => p.name);
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