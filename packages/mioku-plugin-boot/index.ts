import {
  botConfig,
  definePlugin,
  logger,
  type MiokiContext,
  wait,
} from "mioki";
import {
  registerPluginArtifacts,
  serviceManager,
  type AIService,
  type ConfigService,
} from "mioku";

type AccessId = string | number;

interface AccessRuleConfig {
  whitelist: AccessId[];
  blacklist: AccessId[];
}

interface BootPluginConfig {
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
    };
  };
  messageFilter: {
    user: AccessRuleConfig;
    group: AccessRuleConfig;
  };
}

const BOOT_DEFAULT_CONFIG: BootPluginConfig = {
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
    },
  },
  messageFilter: {
    user: {
      whitelist: [],
      blacklist: [],
    },
    group: {
      whitelist: [],
      blacklist: [],
    },
  },
};

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeBootConfig(config: BootPluginConfig | any): BootPluginConfig {
  const nextConfig = {
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
    messageFilter: {
      user: {
        ...cloneConfig(BOOT_DEFAULT_CONFIG.messageFilter.user),
        ...(config?.messageFilter?.private || {}),
        ...(config?.messageFilter?.user || {}),
      },
      group: {
        ...cloneConfig(BOOT_DEFAULT_CONFIG.messageFilter.group),
        ...(config?.messageFilter?.group || {}),
      },
    },
  } satisfies BootPluginConfig;

  return nextConfig;
}

function normalizeAccessIds(values: AccessId[] | undefined): string[] {
  return (values || [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

function isPrivilegedUser(userId: AccessId | undefined): boolean {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return false;
  }

  const owners = Array.isArray(botConfig?.owners) ? botConfig.owners : [];
  const admins = Array.isArray(botConfig?.admins) ? botConfig.admins : [];

  return [...owners, ...admins].some(
    (value) => String(value).trim() === normalizedUserId,
  );
}

function isTargetAllowed(targetId: AccessId, rule: AccessRuleConfig): boolean {
  const target = String(targetId);
  const whitelist = normalizeAccessIds(rule.whitelist);
  if (whitelist.length > 0) {
    return whitelist.includes(target);
  }

  const blacklist = normalizeAccessIds(rule.blacklist);
  return !blacklist.includes(target);
}

function isMessageAllowed(event: any, config: BootPluginConfig): boolean {
  if (isPrivilegedUser(event?.user_id || event?.sender?.user_id)) {
    return true;
  }

  const userAllowed =
    event?.user_id != null
      ? isTargetAllowed(event.user_id, config.messageFilter.user)
      : true;

  if (!userAllowed) {
    return false;
  }

  if (event?.message_type === "group" && event?.group_id != null) {
    return isTargetAllowed(event.group_id, config.messageFilter.group);
  }

  return true;
}

function isGroupAllowed(groupId: AccessId, config: BootPluginConfig): boolean {
  return isTargetAllowed(groupId, config.messageFilter.group);
}

function isMessageEventName(eventName: unknown): boolean {
  return (
    String(eventName || "") === "message" ||
    String(eventName || "").startsWith("message.")
  );
}

function createGlobalMessageFilterPatcher(
  ctx: MiokiContext,
  getConfig: () => BootPluginConfig,
): () => void {
  const patchedBots: Array<{
    bot: any;
    on: any;
    once: any;
  }> = [];

  for (const bot of ctx.bots || []) {
    if (!bot || typeof bot.on !== "function") {
      continue;
    }

    const originalOn = bot.on.bind(bot);
    const originalOnce =
      typeof bot.once === "function" ? bot.once.bind(bot) : undefined;

    bot.on = (eventName: any, handler: any) => {
      if (!isMessageEventName(eventName) || typeof handler !== "function") {
        return originalOn(eventName, handler);
      }

      return originalOn(eventName, (event: any) => {
        if (!isMessageAllowed(event, getConfig())) {
          return;
        }
        return handler(event);
      });
    };

    if (originalOnce) {
      bot.once = (eventName: any, handler: any) => {
        if (!isMessageEventName(eventName) || typeof handler !== "function") {
          return originalOnce(eventName, handler);
        }

        return originalOnce(eventName, (event: any) => {
          if (!isMessageAllowed(event, getConfig())) {
            return;
          }
          return handler(event);
        });
      };
    }

    patchedBots.push({
      bot,
      on: originalOn,
      once: originalOnce,
    });
  }

  return () => {
    for (const item of patchedBots) {
      item.bot.on = item.on;
      if (item.once) {
        item.bot.once = item.once;
      }
    }
  };
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let output = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{${key}}`).join(value);
  }
  return output;
}

function normalizeGeneratedText(value: string): string {
  return String(value || "")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveMemberName(
  ctx: MiokiContext,
  groupId: number,
  userId: number,
  selfId: number,
): Promise<string> {
  try {
    const member = await ctx
      .pickBot(selfId)
      .getGroupMemberInfo(groupId, userId);
    return (
      String(member?.card || "").trim() ||
      String(member?.nickname || "").trim() ||
      String(userId)
    );
  } catch {
    return String(userId);
  }
}

async function buildWelcomeMessage(options: {
  ctx: MiokiContext;
  aiService?: AIService;
  config: BootPluginConfig;
  groupId: number;
  groupName: string;
  userId: number;
  selfId: number;
}): Promise<string> {
  const { ctx, aiService, config, groupId, groupName, userId, selfId } =
    options;
  const memberName = await resolveMemberName(ctx, groupId, userId, selfId);
  const fallbackText =
    normalizeGeneratedText(
      renderTemplate(config.group.welcome.text, {
        user: memberName,
        group: groupName,
      }),
    ) || `欢迎新人～`;

  if (config.group.welcome.mode !== "ai") {
    return fallbackText;
  }

  const chatRuntime = aiService?.getChatRuntime();
  if (!chatRuntime) {
    return fallbackText;
  }

  try {
    await chatRuntime.generateNotice({
      selfId,
      groupId,
      send: true,
      instruction: [
        "当前有新成员入群，请发送一句欢迎语",
        `新成员：${memberName}`,
        `${config.group.welcome.aiPrompt || ""}`,
      ].join("\n"),
    });

    return "";
  } catch (error) {
    ctx.logger.error(`boot welcome chat-runtime 生成失败: ${error}`);
    return fallbackText;
  }
}

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
    const aiService = ctx.services?.ai as AIService | undefined;
    let baseConfig = cloneConfig(BOOT_DEFAULT_CONFIG);
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

    const restoreGlobalMessageFilter = createGlobalMessageFilterPatcher(
      ctx,
      () => baseConfig,
    );
    disposers.push(restoreGlobalMessageFilter);

    await registerPluginArtifacts(ctx);

    ctx.handle(
      "message",
      async (event: any) => {
        const text = ctx.text(event)?.trim();
        if (!text || event?.user_id === event?.self_id) {
          return;
        }

        if (!baseConfig.likeCommand.enabled) {
          return;
        }

        const keyword = String(baseConfig.likeCommand.keyword || "").trim();
        if (!keyword || text !== keyword) {
          return;
        }

        if (!isMessageAllowed(event, baseConfig)) {
          return;
        }

        const selfId = Number(event?.self_id || ctx.self_id);
        const userId = Number(event?.user_id || event?.sender?.user_id || 0);
        if (!userId) {
          return;
        }

        const bot = ctx.pickBot(selfId);
        const likeTimes = Math.max(
          1,
          Number(baseConfig.likeCommand.likeTimes) || 10,
        );
        const reactionEmojiId = Math.max(
          0,
          Number(baseConfig.likeCommand.reactionEmojiId) || 66,
        );
        const messageId = event?.message_id;

        try {
          await bot.sendLike(userId, likeTimes);
        } catch (error) {
          ctx.logger.warn(`boot sendLike 失败: ${error}`);
        }

        if (messageId == null) {
          return;
        }

        try {
          await bot.api("set_msg_emoji_like", {
            message_id: messageId,
            emoji_id: reactionEmojiId,
            set: true,
          });
        } catch (error) {
          ctx.logger.warn(`boot set_msg_emoji_like 失败: ${error}`);
        }
      },
      { deduplicate: false },
    );

    ctx.handle("request.friend", async (event: any) => {
      if (!baseConfig.friend.autoApprove) {
        return;
      }

      try {
        await event.approve();
        ctx.logger.info(`已自动通过好友申请: ${event.user_id}`);
      } catch (error) {
        ctx.logger.warn(`自动通过好友申请失败: ${error}`);
      }
    });

    ctx.handle("request.group.invite" as any, async (event: any) => {
      if (!isPrivilegedUser(event?.user_id)) {
        return;
      }

      try {
        await event.approve();
        ctx.logger.info(`已自动通过主人/管理员拉群邀请: ${event.user_id}`);
      } catch (error) {
        ctx.logger.warn(`自动通过主人/管理员拉群邀请失败: ${error}`);
      }
    });

    ctx.handle("notice.group.increase" as any, async (event: any) => {
      const selfId = Number(event?.self_id || ctx.self_id);
      const groupId = Number(event?.group_id || 0);
      const userId = Number(event?.user_id || 0);
      if (!groupId || !userId) {
        return;
      }

      const bot = ctx.pickBot(selfId);

      if (userId === selfId) {
        if (
          event?.action_type === "invite" &&
          isPrivilegedUser(event?.operator_id)
        ) {
          ctx.logger.info(
            `群 ${groupId} 由主人/管理员邀请加入，跳过入群限制检查`,
          );
          return;
        }

        const minMemberCount = Math.max(
          0,
          Number(baseConfig.group.minMemberCount) || 0,
        );
        if (minMemberCount <= 0) {
          return;
        }

        try {
          await wait(1000);
          const groupInfo = await bot.getGroupInfo(groupId);
          const memberCount = Number(groupInfo?.member_count || 0);
          if (memberCount > 0 && memberCount < minMemberCount) {
            await bot.api("set_group_leave", {
              group_id: groupId,
              is_dismiss: false,
            });
            ctx.logger.info(
              `群 ${groupId} 人数 ${memberCount} 低于限制 ${minMemberCount}，已自动退群`,
            );
          }
        } catch (error) {
          ctx.logger.warn(`入群人数检查失败: ${error}`);
        }
        return;
      }

      if (
        !baseConfig.group.welcome.enabled ||
        !isGroupAllowed(groupId, baseConfig)
      ) {
        return;
      }

      const groupName =
        String(event?.group?.group_name || "").trim() || String(groupId);
      const welcomeMessage = await buildWelcomeMessage({
        ctx,
        aiService,
        config: baseConfig,
        groupId,
        groupName,
        userId,
        selfId,
      });

      if (!welcomeMessage) {
        return;
      }

      try {
        await bot.sendGroupMsg(groupId, [ctx.segment.text(welcomeMessage)]);
      } catch (error) {
        ctx.logger.warn(`发送入群欢迎失败: ${error}`);
      }
    });

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
