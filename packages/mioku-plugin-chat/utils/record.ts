export type UnknownRecord = Record<string, unknown>;

/** 外部数据进入时的对象收窄 */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** 去空白后的非空字符串 */
export function readTrimmedString(
  value: unknown,
  key: string,
): string | undefined {
  const raw = readField(value, key);
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** null/undefined 返回 undefined，其余转成去空白后的非空字符串 */
export function toOptionalId(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
