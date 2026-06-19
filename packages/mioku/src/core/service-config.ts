import * as fs from "node:fs";
import * as path from "node:path";

const SERVICE_CONFIG_ROOT = "service";

function resolveConfigDir(serviceName: string): string {
  return path.join(process.cwd(), "config", SERVICE_CONFIG_ROOT, serviceName);
}

function resolveConfigPath(serviceName: string, configName: string): string {
  return path.join(resolveConfigDir(serviceName), `${configName}.json`);
}

function ensureDir(serviceName: string): void {
  const dir = resolveConfigDir(serviceName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function registerServiceConfig(
  serviceName: string,
  configName: string,
  defaults: Record<string, any>,
): void {
  ensureDir(serviceName);
  const configPath = resolveConfigPath(serviceName, configName);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf-8");
  }
}

export function getServiceConfig(
  serviceName: string,
  configName: string,
): Record<string, any> {
  const configPath = resolveConfigPath(serviceName, configName);
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {}
  return {};
}

export function updateServiceConfig(
  serviceName: string,
  configName: string,
  value: Record<string, any>,
): void {
  ensureDir(serviceName);
  fs.writeFileSync(
    resolveConfigPath(serviceName, configName),
    JSON.stringify(value, null, 2),
    "utf-8",
  );
}

export function getServiceConfigs(
  serviceName: string,
): Record<string, any> {
  const dir = resolveConfigDir(serviceName);
  if (!fs.existsSync(dir)) {
    return {};
  }

  const result: Record<string, any> = {};
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      result[path.basename(file, ".json")] = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      );
    } catch {}
  }

  return result;
}

export function deleteServiceConfig(
  serviceName: string,
  configName: string,
): boolean {
  const configPath = resolveConfigPath(serviceName, configName);
  if (!fs.existsSync(configPath)) {
    return false;
  }
  fs.unlinkSync(configPath);
  return true;
}
