import type { Event, MiokuContext } from "mioku";
import type { HelpAccessFilter } from "./types";

/** 绑定当前事件的访问过滤器；命令管理器不可用时返回 undefined */
export function createHelpAccessFilter(
  ctx: MiokuContext | undefined,
  event: Event | undefined,
): HelpAccessFilter | undefined {
  const commands = ctx?.commands;
  if (!event || !commands) {
    return undefined;
  }

  return {
    canUsePlugin: (pluginName) => commands.canUsePlugin(pluginName, event),
    canUseCommand: (pluginName, command) =>
      commands.canUseCommand(pluginName, command, event),
  };
}
