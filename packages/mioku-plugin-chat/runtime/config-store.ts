import { getService, Services, type MiokuContext } from "mioku";
import type {
  ChatConfig,
  ChatConfigProvider,
  ChatGroupsFile,
} from "../types";
import { BASE_CONFIG } from "../configs/base";
import { SETTINGS_CONFIG } from "../configs/settings";
import { PERSONALIZATION_CONFIG } from "../configs/personalization";
import { DEFAULT_GROUPS_CONFIG } from "../configs/groups";
import { mergeGroupOverrides } from "../utils/group-config";
import {
  mergeChatConfig,
  normalizeIdList,
  normalizeMediaAnalysisBlacklist,
} from "../utils/config";
import { isRecord } from "../utils/record";
import { LEGACY_API_KEY_SENTINEL, type RoleModels } from "./ai-roles";

const CONFIG_FILES = ["base", "settings", "personalization"] as const;
type ConfigFileName = (typeof CONFIG_FILES)[number] | "groups";

/** 默认配置各文件合起来才是完整的 ChatConfig */
const EMPTY_CONFIG = {} as ChatConfig;

function defaultChatConfig(): ChatConfig {
  return mergeChatConfig(
    mergeChatConfig(mergeChatConfig(EMPTY_CONFIG, BASE_CONFIG), SETTINGS_CONFIG),
    PERSONALIZATION_CONFIG,
  );
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
  }

  const readRaw = async (name: ConfigFileName): Promise<unknown> =>
    configService ? configService.getConfig("chat", name) : undefined;

  const buildGlobalConfig = async (): Promise<ChatConfig> => {
    const defaults = defaultChatConfig();
    if (!configService) return defaults;

    const [base, settings, personalization] = await Promise.all(
      CONFIG_FILES.map(async (name) => (await readRaw(name)) ?? {}),
    );
    const merged = mergeChatConfig(
      mergeChatConfig(mergeChatConfig(defaults, settings), personalization),
      base,
    );

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
