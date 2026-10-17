import {
  bindCapabilities,
  colors,
  avatarSet,
  avatarGet,
  botStatus,
  conversationGetHistory,
  defineAdapter,
  forwardSend,
  friendDelete,
  friendGetInfo,
  friendGetList,
  groupGetInfo,
  groupGetList,
  groupGetMembers,
  groupLeave,
  groupSetName,
  groupSetPortrait,
  groupSetWholeBan,
  memberBan,
  memberGetInfo,
  memberKick,
  memberPoke,
  memberSetAdmin,
  memberSetCard,
  memberSetTitle,
  messageGet,
  messageGetForward,
  messageRecall,
  messageSend,
  profileSet,
  registerStatusProvider,
} from "mioku";
import {
  DEFAULT_INSTANCE,
  normalizeInstances,
  normalizeServerConfig,
} from "./config";
import { createOneBot, type OneBot, type OneBotData } from "./bot";
import { OneBotWebSocketGateway, type ApiCaller } from "./gateway";
import { OneBotServerGateway, OneBotServerSession } from "./server-gateway";
import { createOneBotStatusProvider } from "./status";
import {
  buildMessageEvent,
  buildMetaEvent,
  buildNoticeEvent,
  buildRequestEvent,
} from "./event";
import { buildPayload, sentFromOneBot, stringifyMessage } from "./message";
import { version as adapterVersion } from "../package.json" with { type: "json" };

import type { Adapter, AdapterContext, AdapterFactoryOptions } from "mioku";
import type {
  OneBotAdapterConfig,
  OneBotInstanceConfig,
  OneBotServerConfig,
} from "./config";
import type {
  AdapterStatus,
  Capability,
  Event,
  Logger,
  Bot,
  MessageEvent,
} from "mioku";
import type { WebSocketConnection } from "mioku";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ONEBOT_NOTICE_NOTIFY_MAP: Record<
  string,
  { notice_type: string; sub_type: string }
> = {
  input_status: { notice_type: "friend", sub_type: "input" },
  profile_like: { notice_type: "friend", sub_type: "like" },
  title: { notice_type: "group", sub_type: "title" },
};

const ONEBOT_NOTICE_EVENT_MAP: Record<
  string,
  { notice_type: string; sub_type: string }
> = {
  friend_add: { notice_type: "friend", sub_type: "increase" },
  friend_recall: { notice_type: "friend", sub_type: "recall" },
  offline_file: { notice_type: "friend", sub_type: "offline_file" },
  client_status: { notice_type: "client", sub_type: "status" },
  group_admin: { notice_type: "group", sub_type: "admin" },
  group_ban: { notice_type: "group", sub_type: "ban" },
  group_card: { notice_type: "group", sub_type: "card" },
  group_upload: { notice_type: "group", sub_type: "upload" },
  group_decrease: { notice_type: "group", sub_type: "decrease" },
  group_increase: { notice_type: "group", sub_type: "increase" },
  group_msg_emoji_like: { notice_type: "group", sub_type: "reaction" },
  essence: { notice_type: "group", sub_type: "essence" },
  group_recall: { notice_type: "group", sub_type: "recall" },
};

const buildUrl = (config: OneBotInstanceConfig): string => {
  const protocol = config.protocol ?? DEFAULT_INSTANCE.protocol;
  const host = config.host ?? DEFAULT_INSTANCE.host;
  const port = config.port ?? DEFAULT_INSTANCE.port;
  const token = config.token ?? "";
  const search = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return `${protocol}://${host}:${port}${search}`;
};

const buildMaskedUrl = (config: OneBotInstanceConfig): string => {
  const protocol = config.protocol ?? DEFAULT_INSTANCE.protocol;
  const host = config.host ?? DEFAULT_INSTANCE.host;
  const port = config.port ?? DEFAULT_INSTANCE.port;
  const token = config.token ?? "";
  const search = token ? "?access_token=***" : "";
  return `${protocol}://${host}:${port}${search}`;
};

const logMessage = (
  logger: Logger,
  data: Record<string, unknown>,
  event: MessageEvent,
): void => {
  const msg = stringifyMessage(event.message);
  const sender =
    isObject(data.sender) && typeof data.sender.nickname === "string"
      ? `${data.sender.nickname}(${event.user_id})`
      : `(${event.user_id})`;
  if (event.message_type === "group") {
    const groupName =
      typeof data.group_name === "string" ? data.group_name : "";
    logger.info(`[群:${groupName}(${event.group_id})] ${sender}: ${msg}`);
  } else {
    logger.info(`[私:${sender}] ${msg}`);
  }
};

const logMessageSent = (
  logger: Logger,
  data: Record<string, unknown>,
  event: MessageEvent,
): void => {
  const msg = stringifyMessage(event.message);
  if (event.message_type === "group") {
    const groupName =
      typeof data.group_name === "string" ? data.group_name : "";
    logger.info(`[>>>:群:${groupName}(${event.group_id})] ${msg}`);
  } else {
    logger.info(`[>>>:私:(${event.user_id})] ${msg}`);
  }
};

const buildNoticeFromOneBot = (
  data: Record<string, unknown>,
): {
  notice_type: string;
  sub_type?: string;
  action_type?: string;
} => {
  if (data.notice_type === "notify") {
    const mapped =
      data.sub_type === "poke"
        ? data.group_id
          ? { notice_type: "group", sub_type: "poke" }
          : { notice_type: "friend", sub_type: "poke" }
        : ONEBOT_NOTICE_NOTIFY_MAP[(data.sub_type as string) ?? ""];
    if (mapped) {
      return {
        notice_type: mapped.notice_type,
        sub_type: mapped.sub_type,
        action_type:
          data.sub_type !== mapped.sub_type
            ? (data.sub_type as string)
            : undefined,
      };
    }
  }
  const mapped = ONEBOT_NOTICE_EVENT_MAP[(data.notice_type as string) ?? ""];
  if (mapped) {
    return {
      notice_type: mapped.notice_type,
      sub_type: mapped.sub_type,
      action_type:
        data.sub_type && data.sub_type !== mapped.sub_type
          ? (data.sub_type as string)
          : undefined,
    };
  }
  return {
    notice_type: data.notice_type as string,
    sub_type: data.sub_type as string | undefined,
  };
};

/** 一条 OneBot 链路派发事件所需的依赖 */
interface OneBotEventDeps {
  readonly adapterName: "onebotv11";
  readonly logger: Logger;
  readonly adapterContext: AdapterContext;
  readonly getBot: () => OneBot | null;
  readonly call: ApiCaller;
  readonly onReceive?: () => void;
}

const handleOneBotEvent = async (
  deps: OneBotEventDeps,
  data: Record<string, unknown>,
): Promise<void> => {
  const bot = deps.getBot();
  if (!bot) return;
  const { adapterName, adapterContext, logger } = deps;
  if (data.post_type === "message") {
    deps.onReceive?.();
    const event = buildMessageEvent({
      adapter: adapterName,
      bot,
      data: data as Parameters<typeof buildMessageEvent>[0]["data"],
    });
    logMessage(logger, data, event);
    await adapterContext.dispatch(event);
    return;
  }
  if (data.post_type === "message_sent") {
    const event = buildMessageEvent({
      adapter: adapterName,
      bot,
      data: data as Parameters<typeof buildMessageEvent>[0]["data"],
    });
    logMessageSent(logger, data, event);
    await adapterContext.dispatch(event);
    return;
  }
  if (data.post_type === "notice") {
    const mapped = buildNoticeFromOneBot(data);
    const enriched: Record<string, unknown> = {
      ...data,
      notice_type: mapped.notice_type,
      sub_type: mapped.sub_type ?? data.sub_type,
      action_type: mapped.action_type ?? data.action_type,
    };
    await adapterContext.dispatch(
      buildNoticeEvent({
        adapter: adapterName,
        bot,
        data: enriched as Parameters<typeof buildNoticeEvent>[0]["data"],
      }),
    );
    return;
  }
  if (data.post_type === "request") {
    await adapterContext.dispatch(
      buildRequestEvent({
        adapter: adapterName,
        bot,
        api: deps.call,
        data: data as Parameters<typeof buildRequestEvent>[0]["data"],
      }),
    );
    return;
  }
  if (data.post_type === "meta_event") {
    await adapterContext.dispatch(
      buildMetaEvent({
        adapter: adapterName,
        bot,
        data: data as Parameters<typeof buildMetaEvent>[0]["data"],
      }),
    );
    return;
  }
};

const registerBotCapabilities = (
  ctx: AdapterContext,
  adapterName: "onebotv11",
  currentBot: OneBot,
): { unregisterBot: () => void; unregisterCapabilities: Array<() => void> } => {
  const unregisterBot = ctx.registerBot(currentBot).unregister;
  const register = <I, O>(
    capability: Capability<I, O>,
    handler: (req: I) => Promise<O>,
  ): (() => void) =>
    ctx.registerCapability(
      capability,
      { adapter: adapterName, bot_id: currentBot.bot_id },
      handler,
    );
  const unregisterCapabilities: Array<() => void> = [
    register(messageSend, (req) => currentBot.sendMessage(req.target, req.message)),
    register(messageRecall, async (req) => {
      await currentBot.recallMessage(req.message_id);
    }),
    register(messageGet, (req) => currentBot.getMessage(req.message_id)),
    register(messageGetForward, (req) =>
      currentBot.getForwardMessage(req.message_id),
    ),
    register(memberBan, async (req) => {
      await currentBot.banMember(req.group_id, req.user_id, req.duration);
    }),
    register(memberKick, async (req) => {
      await currentBot.kickMember(req.group_id, req.user_id);
    }),
    register(memberSetCard, async (req) => {
      await currentBot.setMemberCard(req.group_id, req.user_id, req.card);
    }),
    register(memberSetAdmin, async (req) => {
      await currentBot.setMemberAdmin(req.group_id, req.user_id, req.enable);
    }),
    register(memberGetInfo, (req) =>
      currentBot.getMemberInfo(req.group_id, req.user_id),
    ),
    register(groupGetInfo, (req) => currentBot.getGroupInfo(req.group_id)),
    register(groupGetMembers, (req) =>
      currentBot.getGroupMembers(req.group_id),
    ),
    register(groupLeave, async (req) => {
      await currentBot.leaveGroup(req.group_id, req.is_dismiss);
    }),
    register(groupSetName, async (req) => {
      await currentBot.setGroupName(req.group_id, req.group_name);
    }),
    register(groupSetPortrait, async (req) => {
      await currentBot.setGroupPortrait(req.group_id, req.file);
    }),
    register(groupGetList, async () =>
      (await currentBot.getGroupList()).map((g) => ({
        ...g,
        group_id: String(g.group_id),
      })),
    ),
    register(friendGetInfo, (req) => currentBot.getFriendInfo(req.user_id)),
    register(friendDelete, async (req) => {
      await currentBot.deleteFriend(req.user_id);
    }),
    register(friendGetList, async () =>
      (await currentBot.getFriendList()).map((f) => ({
        ...f,
        user_id: String(f.user_id),
      })),
    ),
    register(conversationGetHistory, (req) =>
      currentBot.getHistory(
        req.target,
        req.before == null ? undefined : String(req.before),
        req.limit,
        req.extra,
      ),
    ),
    register(memberPoke, async (req) => {
      await currentBot.sendApi("group_poke", {
        group_id: req.group_id,
        user_id: req.user_id,
      });
    }),
    register(memberSetTitle, async (req) => {
      await currentBot.sendApi("set_group_special_title", {
        group_id: req.group_id,
        user_id: req.user_id,
        special_title: req.title,
      });
    }),
    register(groupSetWholeBan, async (req) => {
      await currentBot.sendApi("set_group_whole_ban", {
        group_id: req.group_id,
        enable: req.enable,
      });
    }),
    register(forwardSend, async (req) => {
      const payload = req.nodes.map((node) => ({
        type: "node",
        data: {
          user_id: node.user_id,
          nickname: node.nickname,
          content: buildPayload(node.content),
        },
      }));
      const common: Record<string, unknown> = {
        messages: payload,
        ...(req.source ? { source: req.source } : {}),
        ...(req.news && req.news.length > 0 ? { news: req.news } : {}),
        ...(req.summary ? { summary: req.summary } : {}),
      };
      const action =
        req.target.type === "group"
          ? "send_group_forward_msg"
          : "send_private_forward_msg";
      const idKey = req.target.type === "group" ? "group_id" : "user_id";
      const sent = await currentBot.sendApi<{
        message_id?: number | string;
      }>(action, {
        [idKey]: req.target.group_id ?? req.target.user_id,
        ...common,
      });
      return sentFromOneBot(sent);
    }),
    register(profileSet, async (req) => {
      const params: Record<string, unknown> = {};
      if (req.nickname != null) params.nickname = req.nickname;
      if (req.personal_note != null) params.personal_note = req.personal_note;
      if (req.sex != null) params.sex = req.sex;
      for (const [key, value] of Object.entries(req)) {
        if (
          !(key in params) &&
          key !== "nickname" &&
          key !== "personal_note" &&
          key !== "sex"
        ) {
          params[key] = value;
        }
      }
      if (Object.keys(params).length > 0)
        await currentBot.sendApi("set_qq_profile", params);
    }),
    register(avatarSet, async (req) => {
      await currentBot.sendApi("set_qq_avatar", { file: req.file });
    }),
    register(avatarGet, async () => {
      return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(currentBot.bot_id)}&s=640`;
    }),
    register(botStatus, async () => {
      const [status, version] = await Promise.all([
        currentBot
          .sendApi<Record<string, unknown>>("get_status")
          .catch(() => null),
        currentBot.getVersionInfo().catch(() => null),
      ]);
      return {
        online: Boolean(status?.online ?? currentBot.online),
        app_name: version?.app_name,
        app_version: version?.app_version,
        protocol_version: version?.protocol_version,
        ...status,
      };
    }),
  ];

  return { unregisterBot, unregisterCapabilities };
};

interface ClientAdapterState {
  bot: OneBot | null;
  botData: OneBotData;
  unregisterBot: (() => void) | null;
  unregisterCapabilities: Array<() => void>;
  unregisterStatus: (() => void) | null;
  statusBotId: string | null;
  sendCount: number;
  receiveCount: number;
}

const buildClientAdapter = (
  instance: OneBotInstanceConfig,
  adapterName: "onebotv11",
  logger: Logger,
  gatewayName: string,
  botLabel: string,
): Adapter => {
  const url = buildUrl(instance);
  const maskedUrl = buildMaskedUrl(instance);
  const state: ClientAdapterState = {
    bot: null,
    botData: {
      bot_id: String(0),
      adapter: adapterName,
      nickname: "",
      online: false,
    },
    unregisterBot: null,
    unregisterCapabilities: [],
    unregisterStatus: null,
    statusBotId: null,
    sendCount: 0,
    receiveCount: 0,
  };
  let gateway: OneBotWebSocketGateway | null = null;
  let adapterContext: AdapterContext | null = null;

  const ensureBot = async (): Promise<void> => {
    if (!adapterContext || !gateway)
      throw new Error("OneBot adapter is not initialized");
    const loginInfo = await gateway.call<{
      user_id: number | string;
      nickname: string;
    }>("get_login_info");
    let appName = "";
    let appVersion = "";
    try {
      const versionInfo = await gateway.call<{
        app_name: string;
        app_version: string;
      }>("get_version_info");
      appName = versionInfo.app_name;
      appVersion = versionInfo.app_version;
    } catch {
      // 平台不返回该字段
    }
    state.botData.bot_id = String(loginInfo.user_id);
    state.botData.nickname = loginInfo.nickname;
    state.botData.connected_at = Date.now();
    if (!state.bot) {
      state.bot = bindCapabilities(
        createOneBot({
          data: state.botData,
          api: gateway.call,
          logger,
          onSend: () => state.sendCount++,
        }),
        adapterContext.getCapabilityRegistry(),
      );
      const registered = registerBotCapabilities(
        adapterContext,
        adapterName,
        state.bot,
      );
      state.unregisterBot = registered.unregisterBot;
      state.unregisterCapabilities = registered.unregisterCapabilities;
    }
    if (state.statusBotId !== state.botData.bot_id) {
      state.unregisterStatus?.();
      state.statusBotId = state.botData.bot_id;
      const statusProvider = createOneBotStatusProvider(() => ({
        send: state.sendCount,
        receive: state.receiveCount,
      }));
      state.unregisterStatus = registerStatusProvider(
        { adapter: adapterName, bot_id: state.statusBotId },
        ({ bot }: { bot: Bot }) =>
          statusProvider({ bot: state.bot as OneBot }),
      );
    }
    if (!state.botData.online) {
      state.botData.online = true;
      logger.info(
        `已连接到 ${colors.cyan(botLabel)}: ${colors.green(`${appName}-v${appVersion} ${loginInfo.nickname}(${state.botData.bot_id})`)}`,
      );
      await adapterContext.emitLifecycle({ type: "bot:connected", bot: state.bot });
    }
  };

  const handleLifecycleFromMeta = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    if (
      data.post_type !== "meta_event" ||
      data.meta_event_type !== "lifecycle" ||
      data.sub_type !== "connect"
    )
      return;
    try {
      await ensureBot();
    } catch (err) {
      logger.warn(
        `Lifecycle connect handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleConnect = async (
    _connection: WebSocketConnection,
  ): Promise<void> => {
    await ensureBot();
  };

  const handleClose = async (): Promise<void> => {
    if (state.bot && state.botData.online) {
      state.botData.online = false;
      await adapterContext?.emitLifecycle({
        type: "bot:disconnected",
        bot: state.bot,
        reason: "connection closed",
      });
    }
  };

  return {
    name: adapterName,
    version: adapterVersion,
    async start(context: AdapterContext): Promise<void> {
      adapterContext = context;
      const driver = context.getDriver();
      logger.info(
        `>>> 正在连接 ${colors.cyan(botLabel)}: ${colors.green(maskedUrl)}`,
      );
      const deps: OneBotEventDeps = {
        adapterName,
        logger,
        adapterContext,
        getBot: () => state.bot,
        call: (action, params) => gateway!.call(action, params),
        onReceive: () => state.receiveCount++,
      };
      const handlers = {
        async onMessage(payload: unknown): Promise<void> {
          if (!payload || typeof payload !== "object") return;
          const obj = payload as Record<string, unknown>;
          if (obj.post_type === "meta_event") {
            await handleLifecycleFromMeta(obj);
          }
          await handleOneBotEvent(deps, obj);
        },
        onOpen(connection: WebSocketConnection): Promise<void> {
          return handleConnect(connection);
        },
        onClose(code: number, reason: string): Promise<void> {
          logger.warn(`OneBot WS closed (code=${code}, reason=${reason})`);
          return handleClose();
        },
        onError(err: Error): Promise<void> {
          logger.error(`OneBot WS error: ${err.message}`);
          return Promise.resolve();
        },
      };
      gateway = new OneBotWebSocketGateway(
        {
          name: gatewayName,
          url,
          ws: driver.websocket,
          logger,
          reconnect: instance.reconnect ?? DEFAULT_INSTANCE.reconnect,
          reconnectInterval:
            instance.reconnectInterval ?? DEFAULT_INSTANCE.reconnectInterval,
          maxReconnectAttempts:
            instance.maxReconnectAttempts ??
            DEFAULT_INSTANCE.maxReconnectAttempts,
          maxReconnectInterval:
            instance.maxReconnectInterval ??
            DEFAULT_INSTANCE.maxReconnectInterval,
          headers: instance.headers,
        },
        handlers,
      );
      context.registerGateway(gateway);
    },
    async stop(reason?: string): Promise<void> {
      if (state.bot && state.botData.online) {
        state.botData.online = false;
        try {
          await adapterContext?.emitLifecycle({
            type: "bot:disconnected",
            bot: state.bot,
            reason: reason ?? "stop",
          });
        } catch (err) {
          logger.warn(
            `Failed to emit bot:disconnected: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (gateway) {
        await gateway.stop(reason);
        gateway = null;
      }
      state.unregisterStatus?.();
      state.unregisterStatus = null;
      state.statusBotId = null;
      for (const dispose of state.unregisterCapabilities) dispose();
      state.unregisterCapabilities = [];
      state.unregisterBot?.();
      state.unregisterBot = null;
      state.bot = null;
    },
  };
};

/** 反向 WS 服务端的一条接入会话的运行状态 */
interface ServerSessionState {
  readonly sessionId: string;
  readonly remote: string;
  session: OneBotServerSession | null;
  bot: OneBot | null;
  botData: OneBotData;
  unregisterBot: (() => void) | null;
  unregisterCapabilities: Array<() => void>;
  unregisterStatus: (() => void) | null;
  statusBotId: string | null;
  sendCount: number;
  receiveCount: number;
  uin: string | null;
  dropped: boolean;
  ensuring: Promise<void> | null;
}

const buildServerAdapter = (
  server: OneBotServerConfig,
  adapterName: "onebotv11",
  logger: Logger,
  gatewayName: string,
): Adapter => {
  const listenHost = server.listenHost;
  const listenPort = server.listenPort;
  const path = server.path;
  const state = {
    adapterContext: null as AdapterContext | null,
    gateway: null as OneBotServerGateway | null,
    sessions: new Map<string, ServerSessionState>(),
  };

  const findSessionByUin = (uin: string): ServerSessionState | null => {
    for (const session of state.sessions.values()) {
      if (session.uin === uin && !session.dropped) return session;
    }
    return null;
  };

  const dropSession = async (
    session: ServerSessionState,
    reason: string,
  ): Promise<void> => {
    if (session.dropped) return;
    session.dropped = true;
    state.sessions.delete(session.sessionId);
    if (session.bot && session.botData.online) {
      session.botData.online = false;
      try {
        await state.adapterContext?.emitLifecycle({
          type: "bot:disconnected",
          bot: session.bot,
          reason,
        });
      } catch (err) {
        logger.warn(
          `Failed to emit bot:disconnected: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    session.unregisterStatus?.();
    session.unregisterStatus = null;
    session.statusBotId = null;
    for (const dispose of session.unregisterCapabilities) dispose();
    session.unregisterCapabilities = [];
    session.unregisterBot?.();
    session.unregisterBot = null;
    session.bot = null;
    await session.session?.close(1000, reason).catch(() => undefined);
  };

  const ensureBot = async (session: ServerSessionState): Promise<void> => {
    const adapterContext = state.adapterContext;
    if (!adapterContext) throw new Error("OneBot adapter is not initialized");
    const link = session.session;
    if (!link || session.dropped) return;
    const loginInfo = await link.call<{
      user_id: number | string;
      nickname: string;
    }>("get_login_info");
    if (session.dropped) return;
    const uin = String(loginInfo.user_id);

    // 同账号新连接顶替旧连接
    const existing = findSessionByUin(uin);
    if (existing && existing !== session) {
      logger.info(
        `反向 WS: 账号 ${uin} 的新连接顶替旧连接 (${existing.remote})`,
      );
      await dropSession(existing, "replaced by newer connection");
    }
    if (session.dropped) return;

    session.uin = uin;
    session.botData.bot_id = uin;
    session.botData.nickname = loginInfo.nickname;
    session.botData.connected_at = Date.now();
    if (!session.bot) {
      session.bot = bindCapabilities(
        createOneBot({
          data: session.botData,
          api: link.call,
          logger,
          onSend: () => session.sendCount++,
        }),
        adapterContext.getCapabilityRegistry(),
      );
      const registered = registerBotCapabilities(
        adapterContext,
        adapterName,
        session.bot,
      );
      session.unregisterCapabilities = registered.unregisterCapabilities;
      session.unregisterBot = registered.unregisterBot;
      const statusProvider = createOneBotStatusProvider(() => ({
        send: session.sendCount,
        receive: session.receiveCount,
      }));
      session.unregisterStatus = registerStatusProvider(
        { adapter: adapterName, bot_id: uin },
        ({ bot }: { bot: Bot }) => statusProvider({ bot: session.bot as OneBot }),
      );
      session.statusBotId = uin;
      session.botData.online = true;
      logger.info(
        `反向 WS 接入: ${colors.green(`${loginInfo.nickname}(${uin})`)} 自 ${session.remote}`,
      );
      await adapterContext.emitLifecycle({
        type: "bot:connected",
        bot: session.bot,
      });
    }
  };

  const ensureOnce = (session: ServerSessionState): void => {
    if (session.ensuring || session.dropped) return;
    session.ensuring = ensureBot(session)
      .catch((err) => {
        logger.warn(
          `反向 WS 会话登录信息获取失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        session.ensuring = null;
      });
  };

  return {
    name: adapterName,
    version: adapterVersion,
    async start(context: AdapterContext): Promise<void> {
      state.adapterContext = context;
      const gateway = new OneBotServerGateway(
        {
          name: gatewayName,
          host: listenHost,
          port: listenPort,
          path,
          token: server.token || undefined,
          logger,
        },
        {
          onAccept(accept) {
            const adapterContext = state.adapterContext;
            if (!adapterContext) {
              void accept.close(1013, "adapter not ready");
              return;
            }
            const botData: OneBotData = {
              bot_id: String(0),
              adapter: adapterName,
              nickname: "",
              online: false,
            };
            const sessionState: ServerSessionState = {
              sessionId: accept.id,
              remote: accept.remote,
              session: null,
              bot: null,
              botData,
              unregisterBot: null,
              unregisterCapabilities: [],
              unregisterStatus: null,
              statusBotId: null,
              sendCount: 0,
              receiveCount: 0,
              uin: null,
              dropped: false,
              ensuring: null,
            };
            const deps: OneBotEventDeps = {
              adapterName,
              logger,
              adapterContext,
              getBot: () => sessionState.bot,
              call: (action, params) => {
                const link = sessionState.session;
                if (!link) {
                  return Promise.reject(new Error("OneBot session is not ready"));
                }
                return link.call(action, params);
              },
              onReceive: () => sessionState.receiveCount++,
            };
            const session = new OneBotServerSession(
              accept.id,
              accept.socket,
              accept.remote,
              {
                onMessage: async (payload) => {
                  if (!payload || typeof payload !== "object") return;
                  const obj = payload as Record<string, unknown>;
                  if (
                    obj.post_type === "meta_event" &&
                    obj.meta_event_type === "lifecycle" &&
                    obj.sub_type === "connect"
                  ) {
                    ensureOnce(sessionState);
                  }
                  await handleOneBotEvent(deps, obj);
                },
                onClose: (code, reason) => {
                  logger.warn(
                    `反向 WS 会话关闭 (code=${code}, reason=${reason})`,
                  );
                  void dropSession(sessionState, "connection closed");
                },
                onError: (err) => {
                  logger.warn(`反向 WS 会话错误: ${err.message}`);
                },
              },
              logger,
            );
            sessionState.session = session;
            state.sessions.set(accept.id, sessionState);
            ensureOnce(sessionState);
          },
        },
      );
      state.gateway = gateway;
      context.registerGateway(gateway);
    },
    async stop(reason?: string): Promise<void> {
      const drops: Promise<unknown>[] = [];
      for (const session of state.sessions.values()) {
        drops.push(dropSession(session, reason ?? "stop"));
      }
      await Promise.allSettled(drops);
      if (state.gateway) {
        await state.gateway.stop(reason);
        state.gateway = null;
      }
    },
  };
};

const ADAPTER_NAME = "onebotv11";

export const oneBotAdapterDefinition = defineAdapter<OneBotAdapterConfig>({
  name: ADAPTER_NAME,
  version: adapterVersion,
  apiVersion: 1,
  validateConfig: (config): OneBotAdapterConfig => {
    const raw = config as { instances?: unknown; server?: unknown } | null;
    const instances = normalizeInstances(raw);
    const server = normalizeServerConfig(raw?.server);
    if (!server.enabled && instances.length === 0) {
      throw new Error(
        "onebotv11.instances is empty and onebotv11.server is disabled: at least one connection is required",
      );
    }
    return {
      instances: instances.map((instance) => ({
        ...DEFAULT_INSTANCE,
        ...instance,
      })),
      server,
    };
  },
  create: (options: AdapterFactoryOptions<OneBotAdapterConfig>): Adapter => {
    const instances = [...options.config.instances];
    const adapters = instances.map((instance, index) =>
      buildClientAdapter(
        instance,
        ADAPTER_NAME,
        options.logger,
        `${ADAPTER_NAME}.gateway.${index + 1}`,
        `Bot${index + 1}`,
      ),
    );
    if (options.config.server.enabled) {
      adapters.push(
        buildServerAdapter(
          options.config.server,
          ADAPTER_NAME,
          options.logger,
          `${ADAPTER_NAME}.server`,
        ),
      );
    }
    return {
      name: ADAPTER_NAME,
      version: adapterVersion,
      async start(context: AdapterContext): Promise<void> {
        for (const adapter of adapters) {
          await adapter.start(context);
        }
      },
      async stop(reason?: string): Promise<void> {
        for (let i = adapters.length - 1; i >= 0; i--) {
          await adapters[i].stop(reason);
        }
      },
    };
  },
});

export { buildNoticeFromOneBot };
export type { Event, Capability };
