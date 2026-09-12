import fs from "node:fs";
import path from "node:path";

import type { LogLevel } from "./logger";

/** package.json 中 mioku 字段的结构 */
export interface MiokuConfig {
  /** 指令前缀，缺省为 "." */
  prefix?: string;
  owners: string[];
  admins: string[];
  plugins: string[];
  plugins_dir?: string;
  log_level?: LogLevel;
  /** 启动完成后是否私聊通知第一位 owner */
  online_push?: boolean;
  /** 出错时是否推送给 owner */
  error_push?: boolean;
  /** 谁可以查询运行状态：所有人或仅管理员 */
  status_permission?: "all" | "admin-only";
  /** 去重选项 */
  dedup?: {
    /** 跨适配器事件关联去重 */
    cross_adapter?: boolean;
  };
  adapters?: Record<string, unknown>;
  napcat?: unknown;
}

/** package.json 的宽松形状，只约定 mioku 字段 */
export interface BotConfigJson {
  mioku?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 当前机器人根目录，包一层对象以便整体重定向 */
export const BOT_CWD: { value: string } = { value: process.cwd() };

/** 重设机器人根目录，之后 package.json 的读写都基于它 */
export const setBotCwd = (root: string): void => {
  BOT_CWD.value = path.resolve(root);
};

/** 读取机器人根目录的 package.json */
export const readPackageJson = (): BotConfigJson => {
  const file = path.join(BOT_CWD.value, "package.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `无法在 ${BOT_CWD.value} 下找到 package.json 文件，请确认当前目录是否为机器人根目录`,
    );
  }
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw) as BotConfigJson;
  } catch {
    throw new Error(`package.json 解析失败，请检查 JSON 格式`);
  }
};

/** 写回机器人根目录的 package.json */
export const writePackageJson = (pkg: BotConfigJson): void => {
  const file = path.join(BOT_CWD.value, "package.json");
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2), "utf-8");
};

/** 把 owners 配置规整为字符串数组，非数组时返回空 */
export const normalizeOwners = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.map((v) => String(v) as string);
};

/** 同 normalizeOwners，规整管理员名单 */
export const normalizeAdmins = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.map((v) => String(v) as string);
};

/** 同 normalizeOwners，规整插件列表 */
export const normalizePlugins = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.map((v) => String(v) as string);
};

/** 从 package.json 读取 mioku 配置并补全默认值 */
export const readMiokuConfig = (): MiokuConfig => {
  const raw = readPackageJson();
  const rawMioku = raw.mioku;
  if (!rawMioku || typeof rawMioku !== "object") {
    throw new Error(
      `无法在 package.json 中找到 mioku 配置，请确认 package.json 文件中是否包含 mioku 字段`,
    );
  }
  const config: MiokuConfig = {
    ...(rawMioku as Partial<MiokuConfig>),
    owners: normalizeOwners((rawMioku as { owners?: unknown }).owners),
    admins: normalizeAdmins((rawMioku as { admins?: unknown }).admins),
    plugins: normalizePlugins((rawMioku as { plugins?: unknown }).plugins),
    prefix:
      typeof (rawMioku as { prefix?: unknown }).prefix === "string"
        ? (rawMioku as { prefix: string }).prefix
        : ".",
    plugins_dir:
      typeof (rawMioku as { plugins_dir?: unknown }).plugins_dir === "string"
        ? (rawMioku as { plugins_dir: string }).plugins_dir
        : "plugins",
  };
  if ((rawMioku as { log_level?: unknown }).log_level) {
    config.log_level = (rawMioku as { log_level: LogLevel }).log_level;
  }
  if ((rawMioku as { status_permission?: unknown }).status_permission) {
    config.status_permission = (
      rawMioku as { status_permission: "all" | "admin-only" }
    ).status_permission;
  }
  config.online_push = Boolean(
    (rawMioku as { online_push?: unknown }).online_push,
  );
  config.error_push = Boolean(
    (rawMioku as { error_push?: unknown }).error_push,
  );
  if ((rawMioku as { adapters?: unknown }).adapters) {
    config.adapters = (
      rawMioku as { adapters: Record<string, unknown> }
    ).adapters;
  }
  return config;
};

/** 运行时使用的配置，字段与 MiokuConfig 相同 */
export interface RuntimeMiokuConfig extends MiokuConfig {}

const DEFAULT_CONFIG: RuntimeMiokuConfig = {
  owners: [],
  admins: [],
  plugins: [],
  plugins_dir: "plugins",
  prefix: ".",
};

const loadInitialConfig = (): RuntimeMiokuConfig => {
  try {
    return readMiokuConfig();
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};

/** 全局运行时配置，模块加载时初始化 */
export let botConfig: RuntimeMiokuConfig = loadInitialConfig();

/** 重新读取 package.json 并替换全局配置 */
export const reloadMiokuConfig = (): RuntimeMiokuConfig => {
  botConfig = readMiokuConfig();
  return botConfig;
};

let writable = false;

/** 控制是否允许把配置改动写回 package.json */
export const setWritableConfig = (value: boolean): void => {
  writable = value;
};

/** 在 draft 里直接修改配置；writable 开启时改动会落盘到 package.json */
export const updateMiokuConfig = (
  draft: (config: RuntimeMiokuConfig) => void | Promise<void>,
): Promise<void> => {
  return Promise.resolve(draft(botConfig)).then(() => {
    if (!writable) return;
    const pkg = readPackageJson();
    pkg.mioku = {
      ...(pkg.mioku as Record<string, unknown> | undefined),
      ...botConfig,
    };
    writePackageJson(pkg);
  });
};

/** 判断是否为 owner */
export const isOwner = (id: string): boolean => {
  const target = typeof id === "string" ? id : id;
  return botConfig.owners.includes(target as string);
};

/** 判断是否为管理员 */
export const isAdmin = (id: string): boolean => {
  const target = typeof id === "string" ? id : id;
  return botConfig.admins.includes(target as string);
};

/** 判断是否为 owner 或管理员 */
export const isOwnerOrAdmin = (id: string): boolean => {
  return isOwner(id) || isAdmin(id);
};

/** isOwnerOrAdmin 的别名 */
export const hasRight = (id: string): boolean => isOwnerOrAdmin(id);
