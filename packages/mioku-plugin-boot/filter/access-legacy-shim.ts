import * as fs from "fs";
import * as path from "path";
import { logger } from "mioki";
import type { AccessControlConfig } from "mioku";
import {
  ACCESS_DEFAULT_CONFIG,
  normalizeAccessConfig,
} from "../configs/access-base";

const NEW_ACCESS_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config/boot/access-control.json",
);

const LEGACY_ACCESS_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config/access-control/base.json",
);

interface LegacyAccessRuleConfig {
  whitelist?: Array<string | number>;
  blacklist?: Array<string | number>;
}

interface LegacyMessageFilter {
  user?: LegacyAccessRuleConfig;
  group?: LegacyAccessRuleConfig;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function copyFromLegacyLocation(): boolean {
  if (fs.existsSync(NEW_ACCESS_CONFIG_PATH)) return false;
  const legacy = readJsonSafe<AccessControlConfig>(LEGACY_ACCESS_CONFIG_PATH);
  if (!legacy) return false;
  writeJsonSafe(NEW_ACCESS_CONFIG_PATH, normalizeAccessConfig(legacy));
  logger.info(
    `已从 ${path.relative(process.cwd(), LEGACY_ACCESS_CONFIG_PATH)} 复制到 ${path.relative(process.cwd(), NEW_ACCESS_CONFIG_PATH)}`,
  );
  return true;
}

function migrateFromBootMessageFilter(): AccessControlConfig | null {
  const bootConfigPath = path.resolve(process.cwd(), "config/boot/base.json");

  if (fs.existsSync(NEW_ACCESS_CONFIG_PATH)) return null;

  const bootConfig = readJsonSafe<{ messageFilter?: LegacyMessageFilter }>(
    bootConfigPath,
  );
  if (!bootConfig?.messageFilter) return null;

  const next: AccessControlConfig = normalizeAccessConfig({
    ...ACCESS_DEFAULT_CONFIG,
  });

  writeJsonSafe(NEW_ACCESS_CONFIG_PATH, next);
  logger.info("已从 boot.messageFilter 迁移到 boot/access-control.json");

  const stripped = { ...bootConfig };
  delete (stripped as any).messageFilter;
  writeJsonSafe(bootConfigPath, stripped);
  logger.info("已从 boot/base.json 中移除 messageFilter 字段");

  return next;
}

export function ensureAccessControlConfig(): AccessControlConfig {
  copyFromLegacyLocation();

  const existing = readJsonSafe<AccessControlConfig>(NEW_ACCESS_CONFIG_PATH);
  if (existing) return normalizeAccessConfig(existing);

  const migrated = migrateFromBootMessageFilter();
  if (migrated) return migrated;

  writeJsonSafe(NEW_ACCESS_CONFIG_PATH, ACCESS_DEFAULT_CONFIG);
  return ACCESS_DEFAULT_CONFIG;
}
