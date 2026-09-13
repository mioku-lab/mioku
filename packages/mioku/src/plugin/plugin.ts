import type { MiokuContext } from "../runtime/mioku-context";
import type { TaskContext } from "node-cron";

export type { MiokuContext };

/** 插件卸载时执行的清理函数 */
export type PluginCleanup = () => void | Promise<void>;

/** bot 上线 / 下线时的回调 */
export type BotHandler = (
  event: import("../adapter/types").BotLifecycleEvent,
) => void | Promise<void>;
/** 定时任务回调 */
export type CronHandler = (
  ctx: MiokuContext,
  task: TaskContext,
) => void | Promise<void>;
/** 定时任务实例，来自 node-cron */
export type ScheduledTask = import("node-cron").ScheduledTask;

/**
 * 插件定义
 */
export interface MiokuPlugin {
  name: string;
  /** 加载顺序，数值越小越先加载 */
  priority?: number;
  /** 依赖的其他插件名 */
  dependencies?: string[];
  /** 插件入口，可返回清理函数供卸载时调用 */
  setup?(
    ctx: MiokuContext,
  ): void | Promise<void | PluginCleanup> | PluginCleanup;
}

/** 定义一个插件，仅提供类型约束 */
export const definePlugin = <T extends MiokuPlugin>(plugin: T): T => plugin;
