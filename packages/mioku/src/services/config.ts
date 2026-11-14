import * as fs from "fs/promises";
import * as path from "path";
import { existsSync, mkdirSync } from "fs";
import { rootLogger as logger } from "../logger";
import {
  getConfigDefaults,
  registerConfigDefaults,
  withConfigDefaults,
} from "./config-defaults";

const SERVICE_CONFIG_ROOT = "service";

/** 服务配置目录：`config/service/<serviceName>/` */
function resolveConfigDir(serviceName: string): string {
  return path.join(process.cwd(), "config", SERVICE_CONFIG_ROOT, serviceName);
}

function resolveConfigPath(serviceName: string, configName: string): string {
  return path.join(resolveConfigDir(serviceName), `${configName}.json`);
}

function ensureDir(serviceName: string): void {
  const dir = resolveConfigDir(serviceName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 注册服务配
 */
export async function registerServiceConfig(
  serviceName: string,
  configName: string,
  defaults: Record<string, unknown>,
): Promise<void> {
  ensureDir(serviceName);
  registerConfigDefaults("service", serviceName, configName, defaults);
  const configPath = resolveConfigPath(serviceName, configName);
  if (!existsSync(configPath)) {
    await fs.writeFile(configPath, JSON.stringify(defaults, null, 2), "utf-8");
    return;
  }
  try {
    const existing = JSON.parse(await fs.readFile(configPath, "utf-8"));
    const merged = withConfigDefaults(existing, defaults);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      await fs.writeFile(configPath, JSON.stringify(merged, null, 2), "utf-8");
    }
  } catch (error) {
    logger.warn(
      `[service-config] 补全 ${serviceName}/${configName} 失败: ${error}`,
    );
  }
}

/** 读取服务配置，文件不存在或解析失败时返回空对象 */
export async function getServiceConfig(
  serviceName: string,
  configName: string,
): Promise<Record<string, unknown>> {
  const configPath = resolveConfigPath(serviceName, configName);
  const fallback = getConfigDefaults("service", serviceName, configName);
  try {
    return withConfigDefaults(
      JSON.parse(await fs.readFile(configPath, "utf-8")),
      fallback,
    );
  } catch (error) {
    if (!existsSync(configPath)) return fallback ?? {};
    logger.warn(
      `[service-config] 读取 ${serviceName}/${configName} 失败: ${error}`,
    );
    return fallback ?? {};
  }
}

/** 覆盖写入服务配置 */
export async function updateServiceConfig(
  serviceName: string,
  configName: string,
  value: Record<string, unknown>,
): Promise<void> {
  ensureDir(serviceName);
  await fs.writeFile(
    resolveConfigPath(serviceName, configName),
    JSON.stringify(value, null, 2),
    "utf-8",
  );
}

/** 读取服务的全部配置文件，按配置名索引 */
export async function getServiceConfigs(
  serviceName: string,
): Promise<Record<string, Record<string, unknown>>> {
  const dir = resolveConfigDir(serviceName);
  if (!existsSync(dir)) return {};

  const result: Record<string, Record<string, unknown>> = {};
  const files = (await fs.readdir(dir)).filter((name) =>
    name.endsWith(".json"),
  );
  for (const file of files) {
    const configName = path.basename(file, ".json");
    try {
      result[configName] = withConfigDefaults(
        JSON.parse(await fs.readFile(path.join(dir, file), "utf-8")),
        getConfigDefaults("service", serviceName, configName),
      );
    } catch (error) {
      logger.warn(
        `[service-config] 读取 ${serviceName}/${file} 失败: ${error}`,
      );
    }
  }
  return result;
}

/** 删除服务配置，文件不存在时返回 false */
export async function deleteServiceConfig(
  serviceName: string,
  configName: string,
): Promise<boolean> {
  const configPath = resolveConfigPath(serviceName, configName);
  if (!existsSync(configPath)) return false;
  await fs.unlink(configPath);
  return true;
}
