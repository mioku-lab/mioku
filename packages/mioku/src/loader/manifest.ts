import { rootLogger as logger } from "../logger";
import type {
  AccessHook,
  PluginHelp,
  PluginMetadata,
  PluginPackageConfig,
} from "../types";
import type { PackageJsonLike } from "../types";

const PLUGIN_CONFIG_KEYS = new Set([
  "services",
  "help",
  "accessHooks",
]);

const ACCESS_HOOK_KEYS = new Set([
  "id",
  "match",
  "event",
  "description",
]);

const HELP_KEYS = new Set(["title", "description", "commands"]);

const HELP_COMMAND_KEYS = new Set(["cmd", "id", "desc", "usage", "role"]);

function warnUnknownFields(
  prefix: string,
  obj: Record<string, unknown>,
  allowed: Set<string>,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      logger.warn(`[plugin-manifest] ${prefix} 含未知字段 "${key}"（将被忽略）`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHelp(value: unknown, pluginName: string): PluginHelp | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    logger.warn(`[plugin-manifest] ${pluginName}.help 必须是对象，已忽略`);
    return undefined;
  }
  warnUnknownFields(`${pluginName}.help`, value, HELP_KEYS);

  const title = String(value.title ?? "").trim();
  const description = String(value.description ?? "").trim();
  const rawCommands = value.commands;

  if (!title) {
    logger.warn(`[plugin-manifest] ${pluginName}.help.title 缺失或为空`);
  }
  if (!description) {
    logger.warn(`[plugin-manifest] ${pluginName}.help.description 缺失或为空`);
  }
  if (!Array.isArray(rawCommands)) {
    logger.warn(`[plugin-manifest] ${pluginName}.help.commands 必须是数组`);
    return { title, description, commands: [] };
  }

  const commands: PluginHelp["commands"] = [];
  for (const cmd of rawCommands) {
    if (!isPlainObject(cmd)) {
      logger.warn(`[plugin-manifest] ${pluginName}.help.commands 项不是对象`);
      continue;
    }
    warnUnknownFields(
      `${pluginName}.help.commands[]`,
      cmd,
      HELP_COMMAND_KEYS,
    );
    const cmdName = String(cmd.cmd ?? "").trim();
    const desc = String(cmd.desc ?? "").trim();
    if (!cmdName || !desc) {
      logger.warn(
        `[plugin-manifest] ${pluginName}.help.commands 项缺少 cmd 或 desc`,
      );
      continue;
    }
    commands.push({
      cmd: cmdName,
      id: typeof cmd.id === "string" && cmd.id.trim() ? cmd.id.trim() : undefined,
      desc,
      usage: typeof cmd.usage === "string" ? cmd.usage : undefined,
      role: typeof cmd.role === "string" ? (cmd.role as never) : undefined,
    });
  }

  return { title, description, commands };
}

function validateAccessHooks(
  value: unknown,
  pluginName: string,
): AccessHook[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    logger.warn(`[plugin-manifest] ${pluginName}.accessHooks 必须是数组`);
    return undefined;
  }

  const hooks: AccessHook[] = [];
  for (const hook of value) {
    if (!isPlainObject(hook)) {
      logger.warn(`[plugin-manifest] ${pluginName}.accessHooks 项不是对象`);
      continue;
    }
    warnUnknownFields(
      `${pluginName}.accessHooks[]`,
      hook,
      ACCESS_HOOK_KEYS,
    );
    const id = String(hook.id ?? "").trim();
    if (!id) {
      logger.warn(
        `[plugin-manifest] ${pluginName}.accessHooks 项缺少 id，已忽略`,
      );
      continue;
    }
    hooks.push({
      id,
      match: typeof hook.match === "string" ? hook.match : undefined,
      event: typeof hook.event === "string" ? hook.event : undefined,
      description:
        typeof hook.description === "string" ? hook.description : undefined,
    });
  }
  return hooks;
}

export function validatePluginPackageConfig(
  raw: unknown,
  pluginName: string,
): PluginPackageConfig {
  const config: PluginPackageConfig = {};

  if (raw === undefined || raw === null) {
    return config;
  }
  if (!isPlainObject(raw)) {
    logger.warn(
      `[plugin-manifest] ${pluginName} 的 mioku 字段必须是对象，已使用空配置`,
    );
    return config;
  }

  warnUnknownFields(`${pluginName}.mioku`, raw, PLUGIN_CONFIG_KEYS);

  if (raw.services !== undefined) {
    if (Array.isArray(raw.services)) {
      const services = raw.services.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      const dropped = raw.services.length - services.length;
      if (dropped > 0) {
        logger.warn(
          `[plugin-manifest] ${pluginName}.services 丢弃 ${dropped} 个非字符串项`,
        );
      }
      config.services = services;
    } else {
      logger.warn(`[plugin-manifest] ${pluginName}.services 必须是字符串数组`);
    }
  }

  const help = validateHelp(raw.help, pluginName);
  if (help) config.help = help;

  const hooks = validateAccessHooks(raw.accessHooks, pluginName);
  if (hooks) config.accessHooks = hooks;

  return config;
}

export const buildPluginMetadata = (
  name: string,
  resolvedPath: string,
  packageJson: PackageJsonLike,
): PluginMetadata => ({
  name,
  version: packageJson.version ?? "0.0.0",
  description: packageJson.description,
  path: resolvedPath,
  packageJson,
  config: validatePluginPackageConfig(packageJson.mioku, name),
});