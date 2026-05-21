import * as fs from "fs/promises";
import * as path from "path";
import { existsSync, mkdirSync } from "fs";
import { logger } from "mioki";
import type { PluginMetadata } from "./types";

const PLUGIN_MANAGER_SYMBOL = Symbol.for("mioku.plugin-manager");

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 插件管理器
 *
 * Discover and manage plugins from both local directories and node_modules.
 */
export class PluginManager {
  private pluginMetadata: Map<string, PluginMetadata> = new Map();

  public static getInstance(): PluginManager {
    const g = global as any;
    if (!g[PLUGIN_MANAGER_SYMBOL]) {
      g[PLUGIN_MANAGER_SYMBOL] = new PluginManager();
    }
    return g[PLUGIN_MANAGER_SYMBOL];
  }

  async discoverPlugins(miokuConfig: any = {}): Promise<PluginMetadata[]> {
    // Resolve pluginsDir dynamically so it uses the current cwd
    const pluginsDir = miokuConfig.plugins_dir
      ? path.resolve(process.cwd(), miokuConfig.plugins_dir)
      : path.resolve(process.cwd(), "plugins");

    // Ensure plugins directory exists
    if (!(await pathExists(pluginsDir))) {
      mkdirSync(pluginsDir, { recursive: true });
    }

    const discovered: PluginMetadata[] = [];

    // Discover from local plugins/ directory
    if (await pathExists(pluginsDir)) {
      const localPlugins = await this.discoverFromDir(pluginsDir);
      discovered.push(...localPlugins);
    }

    // Discover from node_modules (mioku-plugin-* prefix)
    const nodeModulesPlugins = await this.discoverFromNodeModules();
    discovered.push(...nodeModulesPlugins);

    logger.info(`O.o 发现了 ${this.pluginMetadata.size} 个插件`);
    return Array.from(this.pluginMetadata.values());
  }

  private async discoverFromDir(pluginsDir: string): Promise<PluginMetadata[]> {
    const discovered: PluginMetadata[] = [];

    try {
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginPath = path.join(pluginsDir, entry.name);
        const metadata = await this.loadPluginMetadata(entry.name, pluginPath);
        if (metadata) {
          discovered.push(metadata);
          this.pluginMetadata.set(metadata.name, metadata);
        }
      }
    } catch (error) {
      logger.error(`扫描插件目录失败: ${error}`);
    }

    return discovered;
  }

  private async discoverFromNodeModules(): Promise<PluginMetadata[]> {
    const discovered: PluginMetadata[] = [];
    const nodeModulesPath = path.resolve(process.cwd(), "node_modules");

    if (!(await pathExists(nodeModulesPath))) {
      return discovered;
    }

    try {
      const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
      for (const entry of entries) {
        // Check for mioku-plugin-* prefix
        if (!entry.isDirectory() || !entry.name.startsWith("mioku-plugin-")) {
          continue;
        }

        const pluginName = entry.name.replace(/^mioku-plugin-/, "");
        const pluginPath = path.join(nodeModulesPath, entry.name);
        const metadata = await this.loadPluginMetadata(pluginName, pluginPath);
        if (metadata) {
          discovered.push(metadata);
          this.pluginMetadata.set(metadata.name, metadata);
        }
      }
    } catch (error) {
      logger.debug(`扫描 node_modules 插件失败: ${error}`);
    }

    return discovered;
  }

  private async loadPluginMetadata(
    name: string,
    pluginPath: string,
  ): Promise<PluginMetadata | null> {
    const packageJsonPath = path.join(pluginPath, "package.json");

    let packageJson: any = null;
    try {
      const stats = await fs.stat(packageJsonPath);
      if (stats.isFile()) {
        packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
      }
    } catch {
      // File doesn't exist or can't be read - plugin uses defaults
    }

    const metadata: PluginMetadata = {
      name,
      version: packageJson?.version || "0.0.0",
      description: packageJson?.description,
      path: pluginPath,
      packageJson,
      config: packageJson?.mioku || {},
    };
    return metadata;
  }

  collectRequiredServices(): Set<string> {
    const services = new Set<string>();
    for (const metadata of this.pluginMetadata.values()) {
      if (metadata.config.services) {
        metadata.config.services.forEach((s) => services.add(s));
      }
    }
    return services;
  }

  getPluginMetadata(name: string): PluginMetadata | undefined {
    return this.pluginMetadata.get(name);
  }

  getAllMetadata(): PluginMetadata[] {
    return Array.from(this.pluginMetadata.values());
  }

  reset(): void {
    this.pluginMetadata.clear();
  }
}

export default PluginManager.getInstance();