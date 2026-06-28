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
      minMemberCount:
        Number(config?.group?.minMemberCount) ||
        BOOT_DEFAULT_CONFIG.group.minMemberCount,
    },
  };
  return merged;
}