import { getService, Services, type MiokuContext } from "mioku";
import type {
  ChatConfig,
  ChatConfigProvider,
  ChatGroupsFile,
} from "../types";
import { BASE_CONFIG } from "../configs/base";
import { SETTINGS_CONFIG } from "../configs/settings";
import { PERSONALIZATION_CONFIG } from "../configs/personalization";
import { MEMORY_CONFIG } from "../configs/memory";
import { normalizeMemoryConfig } from "../memory/config";
import { DEFAULT_GROUPS_CONFIG } from "../configs/groups";
import { mergeGroupOverrides } from "../utils/group-config";
import {
  mergeChatConfig,
  normalizeIdList,
  normalizeMediaAnalysisBlacklist,
} from "../utils/config";
import { isRecord } from "../utils/record";
import { LEGACY_API_KEY_SENTINEL, type RoleModels } from "./ai-roles";

const CONFIG_FILES = ["base", "settings", "personalization", "memory"] as const;
type ConfigFileName = (typeof CONFIG_FILES)[number] | "groups";

/** 默认配置各文件合起来才是完整的 ChatConfig */
const EMPTY_CONFIG = {} as ChatConfig;

function defaultChatConfig(): ChatConfig {
  const merged = mergeChatConfig(
    mergeChatConfig(
      mergeChatConfig(
        mergeChatConfig(EMPTY_CONFIG, BASE_CONFIG),
        SETTINGS_CONFIG,
      ),
      stripLegacyPersonalization(PERSONALIZATION_CONFIG),
    ),
    // 记忆是一整块独立配置，必须挂在 memory 下，不能平铺到 ChatConfig 顶層
    { memory: MEMORY_CONFIG },
  );
  merged.memory = normalizeMemoryConfig(merged.memory);
  return merged;
}

/**
 * 老的 personalization.json 里有一个同名的 memory 段（groupHistoryLimit 之类，
 * 早已没有任何代码读取）。不剥掉的话，它会在深合并时和新记忆配置抢 memory 这个键。
 */
function stripLegacyPersonalization(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const next: Record<string, unknown> = { ...raw };
  delete next.memory;
  delete next.planner;
  return next;
}

/**
 * 合并各配置文件 → 完整 ChatConfig。
 *
 * base / settings 平铺在顶层；personalization 先剥掉遗留键；
 * memory 文件对应 ChatConfig.memory 这一块，必须包一层再合并。
 * 抽成纯函数是为了能脱离框架直接验证（见 scripts/memory-smoke.ts）。
 */
export function mergeChatConfigFiles(input: {
  base?: unknown;
  settings?: unknown;
  personalization?: unknown;
  memory?: unknown;
}): ChatConfig {
  const merged = mergeChatConfig(
    mergeChatConfig(
      mergeChatConfig(
        mergeChatConfig(defaultChatConfig(), input.settings ?? {}),
        stripLegacyPersonalization(input.personalization ?? {}),
      ),
      { memory: normalizeMemoryConfig(input.memory) },
    ),
    input.base ?? {},
  );
  merged.memory = normalizeMemoryConfig(merged.memory);
  return merged;
}

function isGroupsFile(value: unknown): value is ChatGroupsFile {
  return isRecord(value) && isRecord(value.groups);
}

export interface ChatConfigStore {
  /** 同步读取已缓存的配置 */
  provider: ChatConfigProvider;
  get(groupId?: string): Promise<ChatConfig>;
  /** AI 角色解析完成后写入模型与视觉能力 */
  applyRoleModels(models: RoleModels, isMultimodal: boolean): Promise<void>;
  /** 订阅某个配置文件的变化，插件卸载时随 dispose 取消 */
  watch(name: ConfigFileName, cb: () => void | Promise<void>): void;
  /** 读取原始配置文件内容 */
  readRaw(name: ConfigFileName): Promise<unknown>;
  dispose(): void;
}

export async function createChatConfigStore(
  ctx: MiokuContext,
): Promise<ChatConfigStore> {
  const configService = getService(ctx, Services.Config);
  const screenshotService = getService(ctx, Services.Screenshot);
  let warnedMarkdownScreenshotUnavailable = false;
  let roleModels: RoleModels = { main: "", working: "", vision: "" };
  let roleIsMultimodal = true;

  if (configService) {
    await configService.registerConfig("chat", "base", BASE_CONFIG);
    await configService.registerConfig("chat", "settings", SETTINGS_CONFIG);
    await configService.registerConfig(
      "chat",
      "personalization",
      PERSONALIZATION_CONFIG,
    );
    await configService.registerConfig("chat", "groups", DEFAULT_GROUPS_CONFIG);
    await configService.registerConfig("chat", "memory", MEMORY_CONFIG);
  }

  const readRaw = async (name: ConfigFileName): Promise<unknown> =>
    configService ? configService.getConfig("chat", name) : undefined;

  const buildGlobalConfig = async (): Promise<ChatConfig> => {
    const defaults = defaultChatConfig();
    if (!configService) return defaults;

    const [base, settings, personalization, memory] = await Promise.all(
      CONFIG_FILES.map(async (name) => (await readRaw(name)) ?? {}),
    );
    // 从默认值出发再合并磁盘配置，缺字段时仍有默认值
    const merged = mergeChatConfigFiles({
      base,
      settings,
      personalization,
      memory,
    });

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
    merged.mediaAnalysisBlacklistUsers = normalizeMediaAnalysisBlacklist(merged);
    Reflect.deleteProperty(merged, "imageAnalysisBlacklistUsers");

    merged.memory = normalizeMemoryConfig(merged.memory);
    merged.model = roleModels.main || merged.model || "";
    merged.workingModel =
      roleModels.working || merged.workingModel || merged.model;
    merged.multimodalWorkingModel =
      roleModels.vision || merged.multimodalWorkingModel || merged.workingModel;
    merged.isMultimodal = roleIsMultimodal;
    if (!roleIsMultimodal) merged.enableMediaRecognition = false;
    if (!merged.apiKey) merged.apiKey = LEGACY_API_KEY_SENTINEL;

    return merged;
  };

  let baseConfig = await buildGlobalConfig();
  let groupsConfig: ChatGroupsFile = DEFAULT_GROUPS_CONFIG;

  const refreshBase = async () => {
    baseConfig = await buildGlobalConfig();
  };
  const refreshGroups = async () => {
    const raw = await readRaw("groups");
    groupsConfig = isGroupsFile(raw) ? raw : DEFAULT_GROUPS_CONFIG;
  };
  await refreshGroups();

  const offs: Array<() => void> = [];
  const watch = (name: ConfigFileName, cb: () => void | Promise<void>) => {
    if (!configService) return;
    offs.push(
      configService.onConfigChange("chat", name, () => {
        Promise.resolve()
          .then(cb)
          .catch((err) =>
            ctx.logger.error(`处理 chat/${name} 配置变更失败: ${err}`),
          );
      }),
    );
  };
  for (const name of CONFIG_FILES) {
    watch(name, () =>
      refreshBase().catch((err) =>
        ctx.logger.error(`刷新 chat/${name} 缓存失败: ${err}`),
      ),
    );
  }
  watch("groups", () =>
    refreshGroups().catch((err) =>
      ctx.logger.error(`刷新 chat/groups 缓存失败: ${err}`),
    ),
  );

  const provider: ChatConfigProvider = (groupId) => {
    if (groupId === undefined) return baseConfig;
    return mergeGroupOverrides(baseConfig, groupsConfig.groups[String(groupId)]);
  };

  return {
    provider,
    get: async (groupId) => provider(groupId),
    async applyRoleModels(models, isMultimodal) {
      roleModels = models;
      roleIsMultimodal = isMultimodal;
      await refreshBase();
    },
    watch,
    readRaw,
    dispose() {
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
