import * as fs from "fs/promises";
import * as path from "path";
import { mkdirSync } from "fs";
import type { PluginMetadata } from "./types";
import { DEFAULT_RUNTIME_PLUGINS_DIR } from "./plugin-linker";
import { logger } from "./logger";

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
    const configuredPluginsDir = miokuConfig.plugins_dir;
    const pluginsDir =
      configuredPluginsDir && configuredPluginsDir !== DEFAULT_RUNTIME_PLUGINS_DIR
        ? path.resolve(process.cwd(), configuredPluginsDir)
        : path.resolve(process.cwd(), "plugins");

    this.pluginMetadata.clear();

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
        const pluginPath = path.join(pluginsDir, entry.name);
        const metadataPath = await this.resolveDirectoryPath(pluginPath);
        if (!metadataPath) continue;

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
        // Check for mioku-plugin-* prefix (don't check isDirectory - symlinks return false)
        if (!entry.name.startsWith("mioku-plugin-")) {
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

  private async resolveDirectoryPath(entryPath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(entryPath);
      return stat.isDirectory() ? entryPath : null;
    } catch {
      return null;
    }
  }

  private async loadPluginMetadata(
    name: string,
    pluginPath: string,
  ): Promise<PluginMetadata | null> {
    // Resolve symlinks to get actual path
    let resolvedPath = pluginPath;
    try {
      resolvedPath = await fs.realpath(pluginPath);
    } catch {
      // Not a symlink or doesn't exist, use original path
    }

    const packageJsonPath = path.join(resolvedPath, "package.json");

    let packageJson: any = null;
    try {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      packageJson = JSON.parse(content);
    } catch {
      // File doesn't exist or can't be read - plugin uses defaults
    }

    const metadata: PluginMetadata = {
      name,
      version: packageJson?.version || "0.0.0",
      description: packageJson?.description,
      path: resolvedPath,
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
