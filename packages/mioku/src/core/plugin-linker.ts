import * as fs from "fs/promises";
import * as path from "path";
import type { PluginMetadata } from "./types";
import { logger } from "./logger";

export const DEFAULT_RUNTIME_PLUGINS_DIR = ".mioku/plugins";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfBrokenSymlink(entryPath: string): Promise<"ok" | "blocked" | "removed"> {
  let stat;
  try {
    stat = await fs.lstat(entryPath);
  } catch {
    return "removed";
  }

  if (!stat.isSymbolicLink()) {
    return "blocked";
  }

  try {
    await fs.realpath(entryPath);
    return "ok";
  } catch {
    await fs.rm(entryPath, { force: true });
    logger.warn(`[plugin-linker] Removed broken plugin link: ${entryPath}`);
    return "removed";
  }
}

function relativeSymlinkTarget(linkPath: string, targetPath: string): string {
  const relativePath = path.relative(path.dirname(linkPath), targetPath);
  return relativePath || ".";
}

async function ensurePluginLink(
  runtimePluginsDir: string,
  metadata: PluginMetadata,
): Promise<boolean> {
  const linkPath = path.join(runtimePluginsDir, metadata.name);
  const targetPath = metadata.path;

  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch {
    stat = null;
  }

  if (stat?.isSymbolicLink()) {
    try {
      const currentTarget = await fs.realpath(linkPath);
      const expectedTarget = await fs.realpath(targetPath);
      if (currentTarget === expectedTarget) {
        return true;
      }
      await fs.rm(linkPath, { force: true });
      logger.info(`[plugin-linker] Rebuilding plugin link: ${metadata.name}`);
    } catch {
      await fs.rm(linkPath, { force: true });
      logger.warn(`[plugin-linker] Removed broken plugin link: ${linkPath}`);
    }
  } else if (stat) {
    logger.warn(
      `[plugin-linker] ${linkPath} exists and is not a symlink, skip linking ${metadata.name}`,
    );
    return false;
  }

  if (!(await pathExists(targetPath))) {
    logger.warn(
      `[plugin-linker] Plugin target missing, skip linking ${metadata.name}: ${targetPath}`,
    );
    return false;
  }

  await fs.symlink(relativeSymlinkTarget(linkPath, targetPath), linkPath, "dir");
  return true;
}

export async function prepareRuntimePluginLinks(
  plugins: PluginMetadata[],
  runtimePluginsDir = path.resolve(process.cwd(), DEFAULT_RUNTIME_PLUGINS_DIR),
): Promise<string[]> {
  await fs.mkdir(runtimePluginsDir, { recursive: true });

  const discoveredNames = new Set(plugins.map((plugin) => plugin.name));
  const entries = await fs.readdir(runtimePluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(runtimePluginsDir, entry.name);
    const symlinkState = await removeIfBrokenSymlink(entryPath);
    if (symlinkState !== "ok") {
      continue;
    }

    if (entry.isSymbolicLink() && !discoveredNames.has(entry.name)) {
      await fs.rm(entryPath, { force: true });
      logger.info(`[plugin-linker] Removed stale plugin link: ${entry.name}`);
    }
  }

  const linkedNames: string[] = [];
  for (const metadata of plugins) {
    if (await ensurePluginLink(runtimePluginsDir, metadata)) {
      linkedNames.push(metadata.name);
    }
  }

  return linkedNames;
}
