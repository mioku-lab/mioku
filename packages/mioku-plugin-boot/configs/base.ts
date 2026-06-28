export interface BootPluginConfig {
  likeCommand: {
    enabled: boolean;
    keyword: string;
    likeTimes: number;
    reactionEmojiId: number;
  };
  friend: {
    autoApprove: boolean;
  };
  group: {
    minMemberCount: number;
    welcome: {
      enabled: boolean;
      mode: "ai" | "text";
      text: string;
      aiPrompt: string;
      batchWindowMs: number;
    };
  };
}

export const BOOT_DEFAULT_CONFIG: BootPluginConfig = {
  likeCommand: {
    enabled: true,
    keyword: "赞我",
    likeTimes: 10,
    reactionEmojiId: 201,
  },
  friend: {
    autoApprove: true,
  },
  group: {
    minMemberCount: 0,
    welcome: {
      enabled: true,
      mode: "ai",
      text: "欢迎新人～",
      aiPrompt: "",
      batchWindowMs: 20000,
    },
  },
};

export function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeBootConfig(config: BootPluginConfig | any): BootPluginConfig {
  const merged: BootPluginConfig = {
    ...cloneConfig(BOOT_DEFAULT_CONFIG),
    ...(config || {}),
    likeCommand: {
      ...cloneConfig(BOOT_DEFAULT_CONFIG.likeCommand),
      ...(config?.likeCommand || {}),
    },
    friend: {
      ...cloneConfig(BOOT_DEFAULT_CONFIG.friend),
      ...(config?.friend || {}),
    },
    group: {
      ...cloneConfig(BOOT_DEFAULT_CONFIG.group),
      ...(config?.group || {}),
      welcome: {
        ...cloneConfig(BOOT_DEFAULT_CONFIG.group.welcome),
        ...(config?.group?.welcome || {}),
      },
    },
  };
  const raw = Number(merged.group.welcome.batchWindowMs);
  merged.group.welcome.batchWindowMs = Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : BOOT_DEFAULT_CONFIG.group.welcome.batchWindowMs;
  return merged;
}
