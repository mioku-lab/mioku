import type { Event, EventHandlerResult } from '../adapter'

export type { EventHandlerResult }

export type EventHandler<E extends Event = Event> = (
  event: E,
) => EventHandlerResult | Promise<EventHandlerResult>

export interface Registration {
  readonly id: number
  readonly route: string
  readonly source: string
  readonly handler: EventHandler<Event>
  readonly priority: number
  readonly order: number
  disposed: boolean
}

export interface BusStats {
  readonly registered: number
  readonly dispatched: number
}

export type RegistrationFilter = (registration: Registration, event: Event) => boolean

const WILDCARD = '*'

const isWildcardMatch = (pattern: string, route: string): boolean => {
  if (pattern === route) return true
  if (!pattern.includes(WILDCARD)) return false
  if (pattern === WILDCARD) return true
  const prefix = pattern.slice(0, -1)
  if (!prefix.endsWith('.')) return false
  return route === prefix.slice(0, -1) || route.startsWith(prefix)
}

/**
 * 事件总线：按路由把事件分发给所有匹配的监听器。
 * 支持 `*` 通配符，同一优先级按注册顺序执行，不同优先级按数值升序。
 */
export class EventBus {
  #registrations: Registration[] = []
  #nextId = 1
  #nextOrder = 0
  #dispatched = 0
  #logger: ((level: 'error' | 'warn' | 'info', message: string, detail?: unknown) => void) | null = null
  #filter: RegistrationFilter | null = null

  setLogger(logger: ((level: 'error' | 'warn' | 'info', message: string, detail?: unknown) => void) | null): void {
    this.#logger = logger
  }

  setFilter(filter: RegistrationFilter | null): void {
    this.#filter = filter
  }

  /** 注册事件监听，返回取消注册函数 */
  register<E extends Event = Event>(
    route: string,
    handler: EventHandler<E>,
    options: { source?: string; priority?: number } = {},
  ): () => void {
    if (!route) {
      throw new Error('EventBus.register: route must be a non-empty string')
    }
    if (typeof handler !== 'function') {
      throw new Error('EventBus.register: handler must be a function')
    }
    const id = this.#nextId++
    const order = this.#nextOrder++
    const reg: Registration = {
      id,
      route,
      source: options.source ?? 'anonymous',
      handler: handler as EventHandler<Event>,
      priority: options.priority ?? 0,
      order,
      disposed: false,
    }
    this.#registrations.push(reg)
    return () => this.#unregister(id)
  }

  #unregister(id: number): void {
    const idx = this.#registrations.findIndex((r) => r.id === id)
    if (idx >= 0) {
      this.#registrations[idx].disposed = true
      this.#registrations.splice(idx, 1)
    }
  }

  clear(): void {
    for (const reg of this.#registrations) reg.disposed = true
    this.#registrations = []
  }

  #matching(event: Event): Registration[] {
    const matched: Registration[] = []
    for (const reg of this.#registrations) {
      if (reg.disposed) continue
      if (this.#filter) {
        try {
          if (!this.#filter(reg, event)) continue
        } catch (err) {
          this.#logger?.(
            'error',
            `Event registration filter failed for "${reg.source}"`,
            err,
          )
        }
      }
      if (isWildcardMatch(reg.route, event.type)) {
        matched.push(reg)
        continue
      }
      for (const route of event.routes) {
        if (isWildcardMatch(reg.route, route)) {
          matched.push(reg)
          break
        }
      }
    }
    return matched
  }

  /**
   * 按优先级顺序把事件交给监听器，返回是否有人认领。
   *
   * 每个优先级组内按注册顺序逐个执行。handler 返回 `true` 即结束派发；
   * 返回 `undefined` / `false` 则继续交给后续监听器，全部不认领时静默结束。
   * 单个监听器出错只记日志，不影响后续监听器。
   */
  async dispatch(event: Event): Promise<boolean> {
    const matched = this.#matching(event)
    if (matched.length === 0) return false
    this.#dispatched++

    const priorityGroups = new Map<number, Registration[]>()
    for (const reg of matched) {
      const list = priorityGroups.get(reg.priority)
      if (list) list.push(reg)
      else priorityGroups.set(reg.priority, [reg])
    }
    const sortedPriorities = Array.from(priorityGroups.entries()).sort(([a], [b]) => a - b)

    for (const [, regs] of sortedPriorities) {
      regs.sort((a, b) => a.order - b.order)
      for (const reg of regs) {
        if (reg.disposed) continue
        const claimed = await this.#invoke(reg, event)
        if (claimed) return true
      }
    }
    return false
  }

  /** 执行单个监听器；返回它是否认领了这条事件，抛错按未认领处理 */
  async #invoke(reg: Registration, event: Event): Promise<boolean> {
    try {
      return (await reg.handler(event)) === true
    } catch (err) {
      this.#logger?.(
        'error',
        `Event handler "${reg.source}" for route "${reg.route}" failed`,
        err,
      )
      return false
    }
  }

  stats(): BusStats {
    return {
      registered: this.#registrations.length,
      dispatched: this.#dispatched,
    }
  }
}
