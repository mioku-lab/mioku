import { atOf, buildRoutes, createFriendRef, createGroupRef } from "mioku";
import type {
  Bot,
  EventIdentity,
  MessageEvent,
  NoticeEvent,
  RequestEvent,
  SenderInfo,
} from "mioku";
import type {
  DiscussMessageEvent,
  FriendRequestEvent,
  GroupInviteEvent,
  GroupMessageEvent,
  GroupRequestEvent,
  PrivateMessageEvent,
} from "mioku-adapter-icqq/vendor/icqq";
import {
  genDmMessageId,
  genGroupMessageId,
} from "mioku-adapter-icqq/vendor/icqq";
import { fromIcqqMessage, toIcqqMessage } from "../message";

type IcqqMessageEvent =
  | PrivateMessageEvent
  | GroupMessageEvent
  | DiscussMessageEvent;

const id = (value: number | string | undefined): string | undefined =>
  value == null ? undefined : String(value);

const quoteIdOf = (event: IcqqMessageEvent): string | undefined => {
  const source = event.source;
  if (!source) return undefined;
  try {
    if (event.message_type === "group") {
      return genGroupMessageId(
        (event as GroupMessageEvent).group_id,
        source.user_id,
        source.seq,
        source.rand,
        source.time,
      );
    }
    if (event.message_type === "private") {
      // 私聊 id 只用于 pickUser(对方).getChatHistory(time) 定位，因此固定填对方账号
      return genDmMessageId(
        Number(event.user_id),
        source.seq,
        source.rand,
        source.time,
        0,
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
};
const identity = (
  bot: Bot,
  eventType: string,
  messageId?: string,
  time?: number,
  native?: string,
): EventIdentity => ({
  adapter: bot.adapter,
  bot_id: bot.bot_id,
  event_type: eventType,
  message_id: messageId,
  timestamp: time ? time * 1000 : undefined,
  native_event_id: native,
});

const senderOf = (sender: IcqqMessageEvent["sender"]): SenderInfo => ({
  user_id: String(sender.user_id),
  nickname: sender.nickname,
  card:
    "card" in sender && typeof sender.card === "string"
      ? sender.card
      : undefined,
  role:
    "role" in sender && typeof sender.role === "string"
      ? sender.role
      : undefined,
});

export const buildMessageEvent = (
  bot: Bot,
  event: IcqqMessageEvent,
): MessageEvent => {
  const isGroup = event.message_type === "group";
  const userId = String(event.sender.user_id);
  const groupId = isGroup
    ? String((event as GroupMessageEvent).group_id)
    : undefined;
  const message = fromIcqqMessage(event.message, event.raw_message);
  const target = isGroup
    ? { type: "group", group_id: groupId }
    : { type: "private", user_id: userId };
  return {
    kind: "message",
    type: "message",
    routes: buildRoutes(
      bot.adapter,
      "message",
      event.message_type,
      "sub_type" in event ? event.sub_type : undefined,
    ),
    identity: identity(
      bot,
      `message.${event.message_type}`,
      event.message_id,
      event.time,
    ),
    self_id: bot.bot_id,
    bot,
    time: event.time * 1000,
    raw: event,
    message_type: event.message_type,
    sub_type: "sub_type" in event ? String(event.sub_type) : undefined,
    user_id: userId,
    group_id: groupId,
    group_name: isGroup ? (event as GroupMessageEvent).group_name : undefined,
    message_id: event.message_id,
    quote_id: quoteIdOf(event),
    raw_message: event.raw_message,
    sender: senderOf(event.sender),
    group: isGroup
      ? createGroupRef(bot, groupId!, (event as GroupMessageEvent).group_name)
      : undefined,
    friend: !isGroup
      ? createFriendRef(bot, userId, event.sender.nickname)
      : undefined,
    message,
    is_to_me: isGroup ? (event as GroupMessageEvent).atme : false,
    at: atOf(message),
    reply: async (input, options) => {
      const quote = typeof options === "boolean" ? options : options?.quote;
      if ("reply" in event) {
        const sent = await event.reply(toIcqqMessage(input), quote);
        return { message_id: sent.message_id, sent_at: sent.time * 1000 };
      }
      return bot.sendMessage(target, input);
    },
    recall: async () => {
      await bot.recallMessage(event.message_id);
    },
  };
};

export const buildNoticeEvent = (
  bot: Bot,
  event: Record<string, unknown>,
): NoticeEvent => {
  // 部分通知事件（poke/ban/admin/increase/decrease/reaction/sign/transfer 等）没有 time 字段
  const seconds = Number(event.time);
  const hasTime = Number.isFinite(seconds) && seconds > 0;
  const noticeType = String(event.notice_type ?? "unknown");
  return {
    kind: "notice",
    type: "notice",
    routes: buildRoutes(
      bot.adapter,
      "notice",
      noticeType,
      id(event.sub_type as string | undefined),
    ),
    identity: identity(
      bot,
      `notice.${noticeType}`,
      undefined,
      hasTime ? seconds : undefined,
    ),
    self_id: bot.bot_id,
    bot,
    time: hasTime ? seconds * 1000 : undefined,
    raw: event,
    notice_type: noticeType,
    sub_type: id(event.sub_type as string | undefined),
    user_id: id(event.user_id as number | undefined),
    group_id: id(event.group_id as number | undefined),
    operator_id: id(event.operator_id as number | undefined),
  };
};

export const buildRequestEvent = (
  bot: Bot,
  event: FriendRequestEvent | GroupRequestEvent | GroupInviteEvent,
  respond: (yes: boolean, reason?: string) => Promise<boolean>,
): RequestEvent => ({
  kind: "request",
  type: "request",
  routes: buildRoutes(
    bot.adapter,
    "request",
    event.request_type,
    event.sub_type,
  ),
  identity: identity(
    bot,
    `request.${event.request_type}`,
    undefined,
    event.time,
    event.flag,
  ),
  self_id: bot.bot_id,
  bot,
  time: event.time * 1000,
  raw: event,
  request_type: event.request_type,
  sub_type: event.sub_type,
  user_id: String(event.user_id),
  group_id: "group_id" in event ? String(event.group_id) : undefined,
  flag: event.flag,
  comment: "comment" in event ? event.comment : undefined,
  approve: async () => {
    await respond(true);
  },
  reject: async (reason) => {
    await respond(false, reason);
  },
});

export { toIcqqMessage };
