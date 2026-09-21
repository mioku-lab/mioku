import {
  isEventAdmin as isEventAdminImpl,
  isEventAdminConfigOnly,
  isEventGroupAdmin,
  isEventGroupOwner,
  isEventMaster as isEventMasterImpl,
  isEventOwner as isEventOwnerImpl,
  isEventOwnerOrAdmin as isEventOwnerOrAdminImpl,
  hasEventRight as hasEventRightImpl,
  toUserId,
} from './permissions'
import nodeCron from 'node-cron'
import {
  createCmd as createCmdUtil,
  createDB as createDBUtil,
  createStore as createStoreUtil,
  match as matchMessage,
  text as extractText,
  type CreateCmdOptions,
  type HasMessage,
} from '../utils'
import * as utilsExports from '../utils'
import { segment } from '../adapter'
import {
  noticeAdmins as noticeAdminsAction,
  noticeFriends as noticeFriendsAction,
  noticeGroups as noticeGroupsAction,
  noticeOwners as noticeOwnersAction,
} from '../actions'
import { addService as registerService, servicesRegistry } from '../services'

import type { Adapter, AdapterBotMap } from '../adapter'
import type { Bot } from '../adapter'
import type { Driver } from '../driver'
import type { Event, MessageEvent, MetaEvent, NoticeEvent, RequestEvent } from '../adapter'
import type { BotLifecycleEvent } from '../adapter'
import type { Logger } from '../logger'
import type { MiokuConfig } from '../config'
import type { EventBus } from './bus'
import type { CronHandler, PluginCleanup, ScheduledTask } from '../plugin'
import type { TaskContext } from 'node-cron'
import type { CapabilityRegistry } from '../adapter'
import type { BotRegistry } from './bots'
import type { Message, MessageInput } from '../adapter'
import type { CorrelationRecord, CorrelationStats, EventCorrelator } from './event-correlator'
import type { CommandDefinition, CommandHandler, CommandManager, CommandMatcher, CommandShortcutOptions } from './commands'

/** 插件管理器：插件列表查询与运行时启停 */
export interface PluginManager {
  list(): Array<{ name: string; type: 'builtin' | 'external'; version?: string }>
  localPlugins(): string[]
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
  reload(name: string): Promise<void>
}

export interface ContextOptions {
  readonly pluginName: string
  readonly pluginId: string
  readonly bus: EventBus
  readonly commands: CommandManager
  readonly bots: BotRegistry
  readonly driver: Driver
  readonly capabilities: CapabilityRegistry
  readonly config: MiokuConfig
  readonly logger: Logger
  readonly priority: number
  readonly getAdapter: <T extends Adapter = Adapter>(name: string) => T | undefined
  readonly listAdapters: () => readonly Adapter[]
  readonly onUpdateConfig: (updater: (config: MiokuConfig) => void | Promise<void>) => Promise<void>
  readonly pluginManager: PluginManager
  /** runtime 级事件关联器；缺省时不做跨适配器去重 */
  readonly correlator?: EventCorrelator
}

/** 从事件对象中提取发送者 id（支持裸 id / user_id / sender.user_id） */
export { toUserId }

/** 仅看 owners 名单：bot 主人（无群身份加成） */
export const isEventMaster = (event: unknown): boolean => isEventMasterImpl(event)

/**
 * master 或当前群群主。等价于 `ctx.command({ permission: "owner" })` 的判断。
 */
export const isEventOwner = (event: unknown): boolean => isEventOwnerImpl(event)

/**
 * master、配置管理员、当前群群主或群管理员。等价于 `ctx.command({ permission: "admin" })` 的判断。
 */
export const isEventAdmin = (event: unknown): boolean => isEventAdminImpl(event)

export const isEventOwnerOrAdmin = (event: unknown): boolean => isEventOwnerOrAdminImpl(event)
export const hasEventRight = (event: unknown): boolean => hasEventRightImpl(event)

// 重新导出群身份 / 配置名单判断，便于插件在需要更细粒度判断时使用
export { isEventGroupOwner, isEventGroupAdmin, isEventAdminConfigOnly }

type SemanticRoute<R extends string> = R extends `${string}:${infer Rest}` ? Rest : R

type NormalizeRoute<R extends string> = R extends `!${infer Rest}` ? Rest : R

type EventKindOfSemanticRoute<R extends string> = R extends `message${string}`
  ? MessageEvent
  : R extends `notice${string}`
    ? NoticeEvent
    : R extends `request${string}`
      ? RequestEvent
      : R extends `meta_event${string}`
        ? MetaEvent
        : Event

export type EventKindOfRoute<R extends string> = EventKindOfSemanticRoute<SemanticRoute<NormalizeRoute<R>>>

type AdapterBotOf<Name extends string> = Name extends keyof AdapterBotMap
  ? AdapterBotMap[Name] extends Bot
    ? AdapterBotMap[Name]
    : Bot
  : Bot

type BotOfRoute<R extends string> = R extends `${infer Adapter}:${string}` ? AdapterBotOf<Adapter> : Bot

type BindRouteBot<E, B extends Bot> = E extends { bot: Bot; self_id: string }
  ? Omit<E, 'bot' | 'self_id'> & { bot: B; self_id: B['bot_id'] }
  : E

type RouteEventOf<R extends string> = BindRouteBot<EventKindOfRoute<R>, BotOfRoute<R>>

export type RouteEvent<R extends string | readonly string[]> = R extends readonly string[]
  ? RouteEventOf<R[number]>
  : RouteEventOf<Extract<R, string>>

const CTX_UTILS = {
  localeDate: utilsExports.localeDate,
  localeTime: utilsExports.localeTime,
  randomInt: utilsExports.randomInt,
  randomItem: utilsExports.randomItem,
  randomItems: utilsExports.randomItems,
  randomId: utilsExports.randomId,
  uuid: utilsExports.uuid,
  wait: utilsExports.wait,
  toArray: utilsExports.toArray,
  unique: utilsExports.unique,
  clamp: utilsExports.clamp,
  noNullish: utilsExports.noNullish,
  isDefined: utilsExports.isDefined,
  isFunction: utilsExports.isFunction,
  isNumber: utilsExports.isNumber,
  isBoolean: utilsExports.isBoolean,
  isString: utilsExports.isString,
  isObject: utilsExports.isObject,
  localNum: utilsExports.localNum,
  formatDuration: utilsExports.formatDuration,
  md5: utilsExports.md5,
  base64Encode: utilsExports.base64Encode,
  base64Decode: utilsExports.base64Decode,
  qs: utilsExports.qs,
  stringifyError: utilsExports.stringifyError,
  getTerminalInput: utilsExports.getTerminalInput,
  find: utilsExports.find,
  filter: utilsExports.filter,
  prettyMs: utilsExports.prettyMs,
  filesize: utilsExports.filesize,
  dayjs: utilsExports.dayjs,
  path: utilsExports.path,
  fs: utilsExports.fs,
  colors: utilsExports.colors,
} as const

type CtxUtils = typeof CTX_UTILS

/**
 * 插件上下文：插件 `setup(ctx)` 收到的对象。
 * 事件监听、定时任务、配置、日志、Bot 操作与工具函数都挂在上面，
 * 同时混入了 `utils` 中的常用工具（dayjs、fs、path、randomInt 等）。
 */
export class MiokuContext {
  readonly #options: ContextOptions
  readonly #cleanup: Set<PluginCleanup> = new Set()

  constructor(options: ContextOptions) {
    this.#options = options
    Object.assign(this, CTX_UTILS)
  }

  #addCleanup(fn: PluginCleanup): void {
    this.#cleanup.add(fn)
  }

  get pluginName(): string {
    return this.#options.pluginName
  }

  get pluginId(): string {
    return this.#options.pluginId
  }

  /** 第一个已连接的 bot（多数单 bot 场景直接用这个） */
  get bot(): Bot | undefined {
    return this.#options.bots.all()[0]
  }

  /** 所有已连接的 bot */
  get bots(): readonly Bot[] {
    return this.#options.bots.all()
  }

  get self_id(): string | undefined {
    return this.bot?.bot_id
  }

  /** 按 bot_id 取指定 bot */
  pickBot<T extends Bot = Bot>(bot_id: string | number): T | undefined {
    return this.#options.bots.pick<T>(bot_id)
  }

  /**
   * 取事件所属的跨适配器关联记录。
   * 同一条逻辑消息被多个适配器/bot 投递时，可从这里读到全部参与方。
   */
  correlation(event: Event): CorrelationRecord | undefined {
    return this.#options.correlator?.observationOf(event)?.record
  }

  /**
   * 观察到该事件的全部已连接 bot（首个即 primary）。
   * 跨适配器去重后，被标记为重复的投递不会进入普通 handler，
   * 但这里依然能看到全部参与方。
   */
  botsForEvent(event: Event): Bot[] {
    const record = this.correlation(event)
    if (!record) {
      const bot = (event as { bot?: Bot }).bot
      return bot ? [bot] : []
    }
    const resolved: Bot[] = []
    for (const participant of record.participants) {
      const bot = participant.botId
        ? (this.#options.bots.find(participant.adapter, participant.botId) ??
          this.#options.bots.pick(participant.botId))
        : undefined
      if (bot && !resolved.includes(bot)) resolved.push(bot)
    }
    return resolved
  }

  /** 事件里被 @ 到的、且本运行时已连接的 bot */
  mentionedBots(event: Event): Bot[] {
    if (event.kind !== 'message') return []
    const targets = new Set<string>()
    for (const segment of event.message) {
      if (segment.type !== 'at') continue
      const data = segment.data ?? {}
      const target = (data as { qq?: unknown; target?: unknown }).qq ?? (data as { target?: unknown }).target
      if (target != null && String(target) !== '') targets.add(String(target))
    }
    if (targets.size === 0) return []
    return this.#options.bots.all().filter((bot) => targets.has(String(bot.bot_id)))
  }

  /**
   * 这条消息应当由哪个 bot 回应：优先「被 @ 的 bot」，其次是关联组里首个到达的 bot。
   * 插件可用它替代隐式的 `event.bot`，从而不受适配器到达顺序影响。
   */
  pickReplyBot(event: Event): Bot | undefined {
    const mentioned = this.mentionedBots(event)
    if (mentioned.length > 0) return mentioned[0]
    const participants = this.botsForEvent(event)
    if (participants.length > 0) return participants[0]
    return (event as { bot?: Bot }).bot
  }

  /** 事件关联/去重的运行统计 */
  correlationStats(): CorrelationStats | undefined {
    return this.#options.correlator?.stats()
  }

  /**
   * 获取事件引用回复的消息内容。
   * 返回 null 表示没有引用、拿不到对应 bot 或消息已失效。
   */
  async getQuoteMsg(
    event: { quote_id?: string | null; bot?: Bot; self_id?: string },
  ): Promise<import('../capabilities/message').MessageGetResult | null> {
    const quoteId = event?.quote_id
    if (quoteId == null || quoteId === '') return null
    const bot = event.bot ?? (event.self_id != null ? this.pickBot(event.self_id) : undefined)
    if (!bot) return null
    try {
      return (await bot.getMessage(quoteId)) ?? null
    } catch {
      return null
    }
  }

  /** 按名称取适配器实例 */
  getAdapter<T extends Adapter = Adapter>(name: string): T | undefined {
    return this.#options.getAdapter<T>(name)
  }

  /** 所有已加载的适配器实例（含当前没有 bot 连接的） */
  get adapters(): readonly Adapter[] {
    return this.#options.listAdapters()
  }

  /**
   * 注册事件监听。route 支持层级路由，如 `message`、`message.group`、
   * `onebotv11:message`；返回取消监听函数。
   */
  handle<R extends string | readonly string[]>(
    route: R,
    handler: (event: RouteEvent<R>) => void | Promise<void>,
  ): () => void {
    const inputRoutes = Array.isArray(route) ? route : [route]
    const bypassDedup = inputRoutes.some((item) => item.startsWith('!'))
    const routes = inputRoutes.map((item) => item.startsWith('!') ? item.slice(1) : item)
    const source = `plugin:${this.#options.pluginId}`
    const handledEvents = new WeakSet<Event>()
    const correlator = bypassDedup ? undefined : this.#options.correlator
    const wrappedHandler = async (event: Event): Promise<void> => {
      if (handledEvents.has(event)) return
      if (correlator?.isDuplicate(event)) return
      handledEvents.add(event)
      await handler(event as RouteEvent<R>)
    }
    const disposers = routes.map((r) =>
      this.#options.bus.register(r, wrappedHandler, { source, priority: this.#options.priority }),
    )
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) dispose()
    }
    this.#addCleanup(dispose)
    return dispose
  }

  /** 注册消息命令；默认自动匹配框架前缀并在命中后消费消息 */
  command(definition: CommandDefinition): () => void
  command(
    matcher: CommandMatcher,
    handler: CommandHandler,
    options?: CommandShortcutOptions,
  ): () => void
  command(
    definitionOrMatcher: CommandDefinition | CommandMatcher,
    handler?: CommandHandler,
    options: CommandShortcutOptions = {},
  ): () => void {
    const dispose =
      typeof definitionOrMatcher === 'object' &&
      definitionOrMatcher !== null &&
      'name' in definitionOrMatcher
        ? this.#options.commands.register(
            this.#options.pluginId,
            {
              ...definitionOrMatcher,
              priority: definitionOrMatcher.priority ?? this.#options.priority,
            },
            this,
          )
        : this.#options.commands.register(
            this.#options.pluginId,
            definitionOrMatcher,
            handler as CommandHandler,
            { ...options, priority: options.priority ?? this.#options.priority },
            this,
          )
    this.#addCleanup(dispose)
    return dispose
  }

  /** 注册 cron 定时任务，插件卸载时自动停止 */
  cron(expression: string, handler: CronHandler): ScheduledTask {
    const task = nodeCron.schedule(expression, async (taskContext: TaskContext) => {
      try {
        await handler(this, taskContext)
      } catch (err) {
        this.#options.logger.error(`Plugin "${this.#options.pluginName}" cron task failed`, err)
      }
    })
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await task.stop()
      await task.destroy()
    }
    this.#addCleanup(dispose)
    return task
  }

  /** 监听 bot 连接 / 断开 */
  onBot<K extends 'connected' | 'disconnected'>(
    type: K,
    handler: (event: K extends 'connected' ? { bot: Bot } : BotLifecycleEvent) => void | Promise<void>,
  ): () => void {
    const route = type === 'connected' ? 'bot:connected' : 'bot:disconnected'
    return this.handle(route, handler as (event: Event) => void | Promise<void>)
  }

  getDriver(): Driver {
    return this.#options.driver
  }

  /** 当前框架配置（只读） */
  get config(): Readonly<MiokuConfig> {
    return this.#options.config
  }

  /** 修改框架配置（owners、admins、plugins 等） */
  updateConfig(updater: (config: MiokuConfig) => void | Promise<void>): Promise<void> {
    return this.#options.onUpdateConfig(updater)
  }

  get logger(): Logger {
    return this.#options.logger
  }

  get plugins(): PluginManager {
    return this.#options.pluginManager
  }

  get services(): import('../services').MiokuServices {
    return servicesRegistry as import('../services').MiokuServices
  }

  /** 注册一个运行时服务供其他插件取用，返回注销函数 */
  addService<T = unknown>(name: string, value: T, cover?: boolean): () => void {
    const remove = registerService<T>(name, value, cover)
    this.#addCleanup(remove)
    return remove
  }

  get capabilities(): CapabilityRegistry {
    return this.#options.capabilities
  }

  get buses(): EventBus {
    return this.#options.bus
  }

  /** 当前运行时的命令管理器 */
  get commands(): CommandManager {
    return this.#options.commands
  }

  get segment(): typeof segment {
    return segment
  }

  /** 按模式匹配消息文本（支持正则/字符串/关键词数组） */
  match<T extends HasMessage>(
    event: T,
    pattern: Parameters<typeof matchMessage>[1],
    quote?: boolean,
  ): ReturnType<typeof matchMessage> {
    return matchMessage(event, pattern, quote)
  }

  /** 解析命令行字符串为 命令 + 参数 + 选项 */
  createCmd(cmdStr: string, options: CreateCmdOptions = {}): ReturnType<typeof createCmdUtil> {
    return createCmdUtil(cmdStr, options)
  }

  /** 在插件目录下创建一个 JSON 数据存储 */
  createStore<T extends object = object>(
    defaultData: T,
    options: { __dirname?: string; importMeta?: ImportMeta; compress?: boolean; filename?: string } = {},
  ): ReturnType<typeof createStoreUtil<T>> {
    return createStoreUtil<T>(defaultData, options)
  }

  /** 在指定路径创建一个 lowdb 数据库文件 */
  createDB<T extends object = object>(
    filename: string,
    options: { defaultData?: T; compress?: boolean } = {},
  ): ReturnType<typeof createDBUtil<T>> {
    return createDBUtil<T>(filename, options)
  }

  /** 提取事件消息的纯文本 */
  text(source: HasMessage | Message, options?: { trim?: boolean | 'whole' | 'each' }): string {
    return extractText(source, options)
  }

  /** 向多个群发送消息 */
  noticeGroups(groupIds: readonly string[], message: MessageInput, options?: import('../actions').NoticeOptions): Promise<void> {
    return noticeGroupsAction(this.#options.bots.all(), groupIds, message, options)
  }

  /** 向多个好友发送消息 */
  noticeFriends(userIds: readonly string[], message: MessageInput, options?: import('../actions').NoticeOptions): Promise<void> {
    return noticeFriendsAction(this.#options.bots.all(), userIds, message, options)
  }

  /** 向所有主人发送消息 */
  noticeOwners(message: MessageInput, options?: import('../actions').NoticeOptions): Promise<void> {
    return noticeOwnersAction(this.#options.bots.all(), this.#options.config.owners, message, options)
  }

  /** 向所有管理员发送消息 */
  noticeAdmins(message: MessageInput, options?: import('../actions').NoticeOptions): Promise<void> {
    return noticeAdminsAction(this.#options.bots.all(), this.#options.config.admins, message, options)
  }

  isGroupMsg(event: unknown): boolean {
    return utilsExports.isObject(event) && (event as { kind?: unknown }).kind === 'message' &&
      (event as { message_type?: unknown }).message_type === 'group'
  }

  isPrivateMsg(event: unknown): boolean {
    return utilsExports.isObject(event) && (event as { kind?: unknown }).kind === 'message' &&
      (event as { message_type?: unknown }).message_type === 'private'
  }

  /** 事件发送者是否为 bot 主人（仅看 owners 名单，不识别群身份） */
  isMaster(event: unknown): boolean {
    return isEventMaster(event)
  }

  /** 事件发送者是否为 bot 主人或当前群群主；等价于 `permission: "owner"` */
  isOwner(event: unknown): boolean {
    return isEventOwner(event)
  }

  /** 事件发送者是否为 bot 主人、配置管理员、当前群群主或群管理员；等价于 `permission: "admin"` */
  isAdmin(event: unknown): boolean {
    return isEventAdmin(event)
  }

  /** 同 `isAdmin`，保留旧名称 */
  isOwnerOrAdmin(event: unknown): boolean {
    return isEventAdmin(event)
  }

  /** 同 `isAdmin`，别名 */
  hasRight(event: unknown): boolean {
    return isEventAdmin(event)
  }

  async dispose(): Promise<void> {
    const all = Array.from(this.#cleanup)
    this.#cleanup.clear()
    for (const fn of all) {
      try {
        await fn()
      } catch {
        // swallow individual cleanup errors so other plugins can still clean up
      }
    }
  }
}

export interface MiokuContext extends CtxUtils {}
