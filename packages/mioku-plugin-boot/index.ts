import { definePlugin, logger, type MiokiContext } from "mioki";
import {
  pluginManager,
  registerPluginArtifacts,
  serviceManager,
  setPluginRuntimeState,
  getPluginRuntimeState,
  type ConfigService,
} from "mioku";
import {
  BOOT_DEFAULT_CONFIG,
  cloneConfig,
  normalizeBootConfig,
  type BootPluginConfig,
} from "./configs/base";
import { registerLikeCommand } from "./commands/like";
import { registerMinMemberCheck } from "./commands/min-member";
import { registerUpdateCommands } from "./commands/update";
import { registerInstallCommands } from "./commands/install";
import { registerMarketCommands } from "./commands/market";
import { registerRestartCommand } from "./commands/restart";
import { registerLogCommand } from "./commands/log";
import {
  cleanupStaleRestartScripts,
  consumeRestartMarker,
  notifyRestartComplete,
} from "./system/restart";
import { registerAutoApprove } from "./notify/auto-approve";
import { ensureAccessControlConfig } from "./filter/access-legacy-shim";
import { createAccessControlPatcher } from "./filter/access-patcher";
import { normalizeAccessConfig } from "./configs/access-base";
import { matchMessageCommands } from "./filter/matcher-registry";
import type { AccessControlConfig } from "mioku";

export default definePlugin({
  name: "boot",
  version: "1.0.0",
  description: "Mioku 引导与系统功能插件",
  priority: -Infinity,
  async setup(ctx: MiokiContext) {
    logger.info("========================================");
    logger.info("          Mioku 正在引导服务...");
    logger.info("========================================");

    await serviceManager.loadAllServices(ctx);

    const configService = ctx.services?.config as ConfigService | undefined;
    let baseConfig: BootPluginConfig = cloneConfig(BOOT_DEFAULT_CONFIG);
    const disposers: Array<() => void> = [];

    if (configService) {
      await configService.registerConfig("boot", "base", baseConfig);
      const nextConfig = await configService.getConfig("boot", "base");
      if (nextConfig) {
        baseConfig = normalizeBootConfig(nextConfig);
      }
      disposers.push(
        configService.onConfigChange("boot", "base", (next) => {
          baseConfig = normalizeBootConfig(next);
        }),
      );
    } else {
      ctx.logger.warn("config-service 未加载，boot 插件将使用默认配置");
    }

    // 在 artifacts 之前装
    let accessRules: AccessControlConfig = ensureAccessControlConfig();
    if (configService) {
      await configService.registerConfig("boot", "access-control", accessRules);
      const persisted = await configService.getConfig("boot", "access-control");
      if (persisted) {
        accessRules = normalizeAccessConfig(persisted);
      }
      disposers.push(
        configService.onConfigChange("boot", "access-control", (next) => {
          accessRules = normalizeAccessConfig(next);
        }),
      );
    }
    const restoreAccess = createAccessControlPatcher(ctx, () => accessRules);
    disposers.push(restoreAccess);
    logger.info(`访问控制已挂载: ${(ctx.bots || []).length} 个 bot`);

    await registerPluginArtifacts(ctx);

    const bootState = getPluginRuntimeState("boot");
    bootState.matchMessageCommands = (text: string) =>
      matchMessageCommands(pluginManager.getAllMetadata(), text);
    setPluginRuntimeState("boot", bootState);

    cleanupStaleRestartScripts();
    const restartMarker = consumeRestartMarker();
    if (restartMarker) {
      notifyRestartComplete(ctx, restartMarker).catch((err) => {
        ctx.logger.error(`[boot] 重启完成通知失败: ${err}`);
      });
    }

    disposers.push(registerLikeCommand(ctx, () => baseConfig));
    disposers.push(registerAutoApprove(ctx, () => baseConfig));
    disposers.push(registerMinMemberCheck(ctx, () => baseConfig));
    disposers.push(registerUpdateCommands(ctx));
    disposers.push(registerInstallCommands(ctx));
    disposers.push(registerMarketCommands(ctx));
    disposers.push(registerRestartCommand(ctx));
    disposers.push(registerLogCommand(ctx));

    logger.info("========================================");
    logger.info("          Mioku 服务初始化完成");
    logger.info("========================================");

    return async () => {
      for (const dispose of disposers) {
        dispose();
      }

      logger.info("正在关闭 Mioku...");
      await serviceManager.disposeAll();
      logger.info("Mioku 已关闭");
    };
  },
});
