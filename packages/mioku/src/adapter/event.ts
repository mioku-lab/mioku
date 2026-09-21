import type {
  Attachment,
  Message,
  MessageInput,
  MessageTarget,
  ReplyOptions,
  SentMessage,
} from './message'

/** 事件的全局标识：来自哪个适配器、哪个 bot、哪类事件 */
export interface EventIdentity {
  readonly adapter: string
  readonly bot_id?: string
  readonly source_id?: string
  readonly event_type: string
  readonly message_id?: string
  readonly timestamp?: number
  readonly native_event_id?: string
  readonly fingerprint?: string
}

/** 所有事件的公共基础结构 */
export interface EventBase {
  /** 事件大类：message / notice / request / meta_event / adapter */
  readonly kind: string
  /** 事件类型，如 `message`、`notice.group.poke` */
  readonly type: string
  /** 该事件可匹配的路由列表，由 `buildRoutes` 生成 */
  readonly routes: readonly string[]
  readonly identity: EventIdentity
  readonly self_id?: string
  readonly bot?: import('./bot').Bot
  readonly time?: number
  readonly raw?: unknown
}

/** 与具体 bot 绑定的事件（含 message / notice / request / meta_event） */
export interface BotEventBase extends EventBase {
  readonly self_id: string
  readonly bot: import('./bot').Bot
}

export interface SenderInfo {
  readonly user_id?: string
  readonly nickname?: string
  readonly card?: string
  readonly role?: 'owner' | 'admin' | 'member' | (string & {})
}

/** 消息事件：私聊与群聊消息 */
export interface MessageEvent extends BotEventBase {
  readonly kind: 'message'
  readonly message_type: 'private' | 'group' | 'channel' | 'thread' | 'direct' | (string & {})
  readonly sub_type?: string
  readonly user_id?: string
  readonly group_id?: string
  readonly group_name?: string
  readonly message_id?: string
  readonly raw_message?: string
  readonly quote_id?: string
  readonly sender?: SenderInfo
  readonly group?: import('../capabilities/group').Group
  readonly friend?: import('../capabilities/friend').Friend
  readonly message: Message
  readonly is_to_me?: boolean
  readonly at?: string
  /** 回复这条消息 */
  reply(message: MessageInput, options?: boolean | ReplyOptions): Promise<SentMessage>
  recall(): Promise<void>
}

/** 通知事件：群成员变动、戳一戳等 */
export interface NoticeEvent extends BotEventBase {
  readonly kind: 'notice'
  readonly notice_type?: string
  readonly sub_type?: string
  readonly user_id?: string
  readonly group_id?: string
  readonly operator_id?: string
}

/** 请求事件：加群/好友申请，可 approve 或 reject */
export interface RequestEvent extends BotEventBase {
  readonly kind: 'request'
  readonly request_type?: string
  readonly sub_type?: string
  readonly user_id?: string
  readonly group_id?: string
  readonly flag?: string
  readonly comment?: string
  approve(): Promise<void>
  reject(reason?: string): Promise<void>
}

/** 生命周期元事件 */
export interface MetaEvent extends BotEventBase {
  readonly kind: 'meta_event'
  readonly meta_event_type?: string
  readonly sub_type?: string
}

/** 适配器自定义事件：不归属以上四类时使用 */
export interface AdapterEvent extends EventBase {
  readonly kind: 'adapter'
  readonly payload: unknown
}

export type Event = MessageEvent | NoticeEvent | RequestEvent | MetaEvent | AdapterEvent

export type BotEvent = MessageEvent | NoticeEvent | RequestEvent | MetaEvent

export const isMessageEvent = (e: Event): e is MessageEvent => e.kind === 'message'
export const isNoticeEvent = (e: Event): e is NoticeEvent => e.kind === 'notice'
export const isRequestEvent = (e: Event): e is RequestEvent => e.kind === 'request'
export const isMetaEvent = (e: Event): e is MetaEvent => e.kind === 'meta_event'
export const isAdapterEvent = (e: Event): e is AdapterEvent => e.kind === 'adapter'
export const isBotEvent = (e: Event): e is BotEvent =>
  e.kind === 'message' || e.kind === 'notice' || e.kind === 'request' || e.kind === 'meta_event'

export interface EventFactoryOptions<T extends MessageEvent | NoticeEvent | RequestEvent | MetaEvent | AdapterEvent> {
  readonly routes: readonly string[]
  readonly identity: EventIdentity
  readonly bot?: import('./bot').Bot
  readonly self_id?: string
  readonly time?: number
  readonly raw?: unknown
}

/**
 * 根据平台信息生成层级路由列表。
 * 例如 `buildRoutes("onebotv11", "message", "group")` 会生成
 * `onebotv11:message.group`、`onebotv11:message`、`onebotv11`、`message.group`、`message` 等，
 * 监听任意一层都能收到该事件。
 */
export const buildRoutes = (adapter: string, ...parts: (string | undefined | null)[]): string[] => {
  const cleaned = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  const routes: string[] = []
  const platformParts = [adapter, ...cleaned]
  for (let length = platformParts.length; length > 0; length--) {
    const [head, ...rest] = platformParts.slice(0, length)
    routes.push(rest.length > 0 ? `${head}:${rest.join('.')}` : head)
  }
  for (let length = cleaned.length; length > 0; length--) {
    routes.push(cleaned.slice(0, length).join('.'))
  }
  return Array.from(new Set(routes))
}

export type { Attachment, Message, MessageInput, MessageTarget, ReplyOptions, SentMessage }