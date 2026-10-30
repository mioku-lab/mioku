import type { Capability } from "./capability";
import type { CapabilityRegistry } from "./registry";
import type { Driver } from "../driver";
import type { Event, EventHandlerResult } from "./event";

/** 能力的作用目标：按适配器 / bot / 具体资源定位能力实现 */
export interface CapabilityTarget {
  readonly adapter: string;
  readonly bot_id?: string;
  readonly resource_id?: string;
}

/** 适配器定义：适配器包导出的核心对象，`defineAdapter()` 的返回值 */
export interface AdapterDefinition<TConfig = unknown> {
  readonly name: string;
  readonly version: string;
  /** 框架与适配器的 API 约定版本，不匹配会拒绝加载 */
  readonly apiVersion: number;
  readonly create: (
    options: AdapterFactoryOptions<TConfig>,
  ) => Adapter | Promise<Adapter>;
  readonly validateConfig?: (config: unknown) => TConfig;
}

export interface AdapterFactoryOptions<TConfig = unknown> {
  readonly config: TConfig;
  readonly logger: import("../logger").Logger;
}

/** 适配器启动后拿到的上下文：注册 bot、能力、网关与资源，派发事件 */
export interface AdapterContext {
  registerBot(bot: import("./bot").Bot): import("./bot").BotContext;
  unregisterBot(bot_id: string): void;
  getDriver(): Driver;
  registerCapability<I, O>(
    capability: Capability<I, O>,
    target: CapabilityTarget,
    handler: (input: I) => Promise<O>,
  ): () => void;
  getCapabilityRegistry(): CapabilityRegistry;
  registerGateway(gateway: AdapterGateway): () => void;
  registerResource(resource: AdapterResource): () => void;
  /** 派发一个事件，返回是否被某个处理者认领 */
  dispatch(event: Event): Promise<boolean>;
  emitLifecycle(event: BotLifecycleEvent): Promise<void>;
  /**
   * 订阅框架事件总线上的事件
   * 返回取消订阅函数
   */
  listen(
    route: string,
    handler: (event: Event) => EventHandlerResult | Promise<EventHandlerResult>,
  ): () => void;
}

/** 适配器实例：start 时建立连接并注册资源，stop 时释放 */
export interface Adapter {
  readonly name: string;
  readonly version: string;
  /** 底层实现库 */
  readonly impl?: { readonly name: string; readonly version?: string };

  start(context: AdapterContext): Promise<void> | void;
  stop(reason?: string): Promise<void> | void;
}

/** 网关：适配器内部的一个独立连接单元（如一条 WebSocket 连接） */
export interface AdapterGateway {
  readonly name: string;
  start(): Promise<void> | void;
  stop(reason?: string): Promise<void> | void;
}

/** 资源的归属范围：适配器级 / 网关级 / bot 级 */
export type AdapterResourceScope = "adapter" | "gateway" | "bot";

/** 适配器声明的可释放资源，随适配器关闭一并清理 */
export interface AdapterResource {
  readonly name: string;
  readonly scope: AdapterResourceScope;
  readonly gateway?: string;
  readonly bot_id?: string;
  dispose(reason?: string): void | Promise<void>;
}

export interface BotLifecycleEvent {
  readonly type: "bot:connected" | "bot:disconnected";
  readonly bot: import("./bot").Bot;
  readonly reason?: string;
}

export const defineAdapter = <TConfig>(
  definition: AdapterDefinition<TConfig>,
): AdapterDefinition<TConfig> => definition;
