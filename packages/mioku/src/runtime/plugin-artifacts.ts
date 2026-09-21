import type { MiokuContext } from "./mioku-context";
import { getService } from "../services/define";
import { Services } from "../services";
import { servicesRegistry } from "../services";
import { rootLogger as logger } from "../logger";
import { getPluginMetadataList } from "./plugin-metadata";
import { getActiveCommandManager } from "./commands";
import type { HelpService } from "../types";

const commandKey = (value: string): string =>
  String(value).trim().replace(/^[#/.]+\s*/, "").split(/\s+/)[0].toLowerCase();

export async function registerPluginArtifacts(
  ctx?: MiokuContext,
): Promise<void> {
  const helpService = ctx
    ? getService(ctx, Services.Help)
    : (servicesRegistry["help"] as HelpService | undefined);
  const plugins = getPluginMetadataList();
  const commandManager = getActiveCommandManager();
  const metadataByName = new Map(plugins.map((meta) => [meta.name, meta]));
  const pluginNames = new Set<string>([
    ...metadataByName.keys(),
    ...(commandManager?.catalog() ?? [])
      .filter((item) => item.kind === "plugin")
      .map((item) => item.plugin),
  ]);

  let helpCount = 0;
  for (const pluginName of pluginNames) {
    const meta = metadataByName.get(pluginName);
    const generated = commandManager?.getPluginHelp(pluginName) ?? meta?.config?.help;
    const existing = helpService?.getHelp(pluginName);
    const help = generated
      ? {
          ...generated,
          title: existing?.title || generated.title,
          description: existing?.description || generated.description,
          commands: [
            ...(existing?.commands ?? []),
            ...generated.commands.filter((command) => {
              const key = commandKey(command.cmd);
              return !(existing?.commands ?? []).some(
                (item) => commandKey(item.cmd) === key,
              );
            }),
          ],
        }
      : existing;
    if (help) {
      if (helpService) {
        helpService.registerHelp(pluginName, help);
        helpCount++;
      } else {
        logger.warn(
          `[plugin-artifacts] 帮助服务未加载，跳过插件 "${pluginName}" 的帮助注册`,
        );
      }
    }
    const required = meta?.config?.services;
    if (required && required.length > 0) {
      const missing = required.filter((name) => !servicesRegistry[name]);
      if (missing.length > 0) {
        logger.warn(
          `插件 "${pluginName}" 声明依赖服务 [${missing.join(", ")}]，但它们未加载`,
        );
      }
    }
  }

  logger.info(
    `[plugin-artifacts] 已处理 ${pluginNames.size} 个插件，注册帮助 ${helpCount} 个`,
  );
}
