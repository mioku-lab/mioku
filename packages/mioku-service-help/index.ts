import { logger } from "mioki";
import type { MiokuService, PluginHelp } from "mioku";
import { HelpService } from "./types";

class HelpManager implements HelpService {
  private helpRegistry: Map<string, PluginHelp> = new Map();

  registerHelp(pluginName: string, help: PluginHelp): void {
    this.helpRegistry.set(pluginName, help);
    logger.debug(`${pluginName} has registered a help information`);
  }

  getHelp(pluginName: string): PluginHelp | undefined {
    return this.helpRegistry.get(pluginName);
  }

  getAllHelp(): Map<string, PluginHelp> {
    return this.helpRegistry;
  }

  unregisterHelp(pluginName: string): boolean {
    const deleted = this.helpRegistry.delete(pluginName);
    if (deleted) {
      logger.info(`移除帮助信息: ${pluginName}`);
    }
    return deleted;
  }

  dispose(): void {
    this.helpRegistry.clear();
  }
}

/**
 * 帮助服务
 */
const helpService: MiokuService = {
  name: "help",
  version: "1.0.0",
  description: "帮助系统服务",
  api: {} as HelpService,

  async init() {
    this.api = new HelpManager();
    logger.info("help-service 已就绪");
  },

  async dispose() {
    if (this.api && typeof (this.api as any).dispose === "function") {
      (this.api as any).dispose();
    }
    logger.info("help-service 已卸载");
  },
};

export default helpService;
