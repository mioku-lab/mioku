import type { PluginHelp } from "mioku";

export interface HelpService {
  // 注册帮助
  registerHelp(pluginName: string, help: PluginHelp): void;
  // 获取帮助
  getHelp(pluginName: string): PluginHelp | undefined;
  // 获取全部帮助
  getAllHelp(): Map<string, PluginHelp>;
  // 卸载帮助
  unregisterHelp(pluginName: string): boolean;
}
