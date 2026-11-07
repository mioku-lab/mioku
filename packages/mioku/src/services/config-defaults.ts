export type ConfigScope = "plugin" | "service";

const defaults = new Map<string, Record<string, unknown>>();

function key(scope: ConfigScope, owner: string, name: string): string {
  return `${scope}\u0000${owner}\u0000${name}`;
}

/** 登记一份配置的默认值；同名重复登记以最后一次为准 */
export function registerConfigDefaults(
  scope: ConfigScope,
  owner: string,
  name: string,
  value: Record<string, unknown>,
): void {
  if (!value || typeof value !== "object") return;
  defaults.set(key(scope, owner, name), clone(value));
}

/** 取默认值（深拷贝，调用方随便改）；没有登记时返回 undefined */
export function getConfigDefaults(
  scope: ConfigScope,
  owner: string,
  name: string,
): Record<string, unknown> | undefined {
  const stored = defaults.get(key(scope, owner, name));
  return stored ? clone(stored) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 用默认值补齐一份配置
 */
export function withConfigDefaults<T extends Record<string, unknown>>(
  stored: unknown,
  fallback: Record<string, unknown> | undefined,
): T {
  const base = fallback ? clone(fallback) : {};
  return mergeInto(base, stored) as T;
}

function mergeInto(
  base: Record<string, unknown>,
  overrides: unknown,
): Record<string, unknown> {
  if (!isPlainObject(overrides)) return base;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value)) {
      const current = base[name];
      base[name] = mergeInto(isPlainObject(current) ? current : {}, value);
    } else {
      base[name] = Array.isArray(value) ? [...value] : value;
    }
  }
  return base;
}
