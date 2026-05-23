import * as fs from "fs";
import * as path from "path";
import _ from "lodash";
import { logger } from "mioki";
import type { MiokuService } from "mioku";
import { ConfigService } from "./tpyes";

/**
 * 配置管理器实现
 */
class ConfigManager implements ConfigService {
  private readonly configRoot: string;
  private configCache: Map<string, any> = new Map();
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private changeCallbacks: Map<string, Set<(newConfig: any) => void>> =
    new Map();

  constructor(configRoot: string) {
    this.configRoot = configRoot;
    this.ensureConfigRoot();
  }

  private ensureConfigRoot(): void {
    if (!fs.existsSync(this.configRoot)) {
      fs.mkdirSync(this.configRoot, { recursive: true });
    }
  }

  private getPluginDir(pluginName: string): string {
    return path.join(this.configRoot, pluginName);
  }

  private getConfigPath(pluginName: string, configName: string): string {
    return path.join(this.getPluginDir(pluginName), `${configName}.json`);
  }

  private ensurePluginDir(pluginName: string): void {
    const pluginDir = this.getPluginDir(pluginName);
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }
  }

  private async loadConfig(
    pluginName: string,
    configName: string,
  ): Promise<any> {
    const configPath = this.getConfigPath(pluginName, configName);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const configContent = await fs.promises.readFile(configPath, "utf-8");
    return JSON.parse(configContent);
  }

  private async saveConfig(
    pluginName: string,
    configName: string,
    config: any,
  ): Promise<void> {
    const configPath = this.getConfigPath(pluginName, configName);
    await fs.promises.writeFile(
      configPath,
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  private watchConfig(pluginName: string, configName: string): void {
    const cacheKey = `${pluginName}/${configName}`;
    if (this.watchers.has(cacheKey)) {
      return;
    }

    const configPath = this.getConfigPath(pluginName, configName);

    const debouncedReload = _.debounce(async () => {
      const newConfig = await this.loadConfig(pluginName, configName);
      if (newConfig) {
        this.configCache.set(cacheKey, newConfig);
        const callbacks = this.changeCallbacks.get(cacheKey);
        if (callbacks) {
          callbacks.forEach((callback) => callback(newConfig));
        }
        logger.info(`配置热重载: ${cacheKey}`);
      }
    }, 500);

    try {
      const watcher = fs.watch(configPath, { encoding: "utf-8" }, () => {
        debouncedReload();
      });
      this.watchers.set(cacheKey, watcher);
    } catch (error) {
      logger.error(`监听配置失败: ${configPath}`);
    }
  }

  async registerConfig(
    pluginName: string,
    configName: string,
    initialConfig: any,
  ): Promise<boolean> {
    this.ensurePluginDir(pluginName);
    const configPath = this.getConfigPath(pluginName, configName);
    const cacheKey = `${pluginName}/${configName}`;

    try {
      let config: any;
      if (typeof initialConfig === "string") {
        if (fs.existsSync(initialConfig)) {
          const fileContent = await fs.promises.readFile(
            initialConfig,
            "utf-8",
          );
          config = JSON.parse(fileContent);
        } else {
          logger.error(`初始配置文件不存在: ${initialConfig}`);
          return false;
        }
      } else {
        config = initialConfig;
      }

      if (fs.existsSync(configPath)) {
        const existingConfig = await this.loadConfig(pluginName, configName);
        const mergedConfig = _.merge({}, config, existingConfig);
        if (JSON.stringify(existingConfig) === JSON.stringify(mergedConfig)) {
          this.configCache.set(cacheKey, existingConfig);
          this.watchConfig(pluginName, configName);
          return true;
        }
        await this.saveConfig(pluginName, configName, mergedConfig);
        this.configCache.set(cacheKey, mergedConfig);
        this.watchConfig(pluginName, configName);
        return true;
      }

      await this.saveConfig(pluginName, configName, config);
      this.configCache.set(cacheKey, config);
      this.watchConfig(pluginName, configName);
      return true;
    } catch (error: any) {
      logger.error(`注册配置失败: ${error.message}`);
      return false;
    }
  }

  async updateConfig(
    pluginName: string,
    configName: string,
    updates: any,
  ): Promise<boolean> {
    const cacheKey = `${pluginName}/${configName}`;
    try {
      const currentConfig = await this.loadConfig(pluginName, configName);
      if (!currentConfig) {
        logger.error(
          `配置文件不存在: ${this.getConfigPath(pluginName, configName)}`,
        );
        return false;
      }

      const updatedConfig = _.merge({}, currentConfig, updates);
      await this.saveConfig(pluginName, configName, updatedConfig);
      this.configCache.set(cacheKey, updatedConfig);
      return true;
    } catch (e: any) {
      logger.error(`更新配置失败: ${e.message}`);
      return false;
    }
  }

  async getConfig(pluginName: string, configName: string): Promise<any> {
    const cacheKey = `${pluginName}/${configName}`;
    const configPath = this.getConfigPath(pluginName, configName);

    if (!fs.existsSync(configPath)) {
      logger.error(`配置文件不存在: ${configPath}`);
      return null;
    }

    if (this.configCache.has(cacheKey)) {
      return this.configCache.get(cacheKey);
    }

    const config = await this.loadConfig(pluginName, configName);
    if (config) {
      this.configCache.set(cacheKey, config);
      this.watchConfig(pluginName, configName);
    }
    return config;
  }

  onConfigChange(
    pluginName: string,
    configName: string,
    callback: (newConfig: any) => void,
  ): () => void {
    const cacheKey = `${pluginName}/${configName}`;
    if (!this.changeCallbacks.has(cacheKey)) {
      this.changeCallbacks.set(cacheKey, new Set());
    }
    this.changeCallbacks.get(cacheKey)!.add(callback);

    return () => {
      this.changeCallbacks.get(cacheKey)?.delete(callback);
    };
  }

  async getPluginConfigs(pluginName: string): Promise<Record<string, any>> {
    const pluginDir = this.getPluginDir(pluginName);

    if (!fs.existsSync(pluginDir)) {
      return {};
    }

    try {
      const configs: Record<string, any> = {};
      const files = await fs.promises.readdir(pluginDir);

      for (const file of files) {
        if (file.endsWith(".json")) {
          const configName = path.basename(file, ".json");
          const config = await this.getConfig(pluginName, configName);
          if (config) {
            configs[configName] = config;
          }
        }
      }

      return configs;
    } catch (error: any) {
      logger.error(`获取插件配置失败: ${error.message}`);
      return {};
    }
  }

  dispose(): void {
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers.clear();
    this.configCache.clear();
    this.changeCallbacks.clear();
  }
}

/**
 * 配置服务
 */
const configService: MiokuService = {
  name: "config",
  version: "1.0.0",
  description: "配置管理服务",
  api: {} as ConfigService,

  async init() {
    const configRoot = path.join(process.cwd(), "config");
    this.api = new ConfigManager(configRoot);

    logger.info("config-service 已就绪");
  },

  async dispose() {
    if (this.api && typeof this.api.dispose === "function") {
      this.api.dispose();
    }
    logger.info("config-service 已卸载");
  },
};

export default configService;
