import { isRecord, type UnknownRecord } from "./record";

function mergeRecords(defaults: object, overrides: unknown): UnknownRecord {
  const result: UnknownRecord = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (isRecord(value)) {
      result[key] = mergeRecords(value, {});
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }

  if (!isRecord(overrides)) return result;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (isRecord(value)) {
      const baseValue = result[key];
      result[key] = mergeRecords(isRecord(baseValue) ? baseValue : {}, value);
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }

  return result;
}

/** 深合并：对象递归，数组整体替换，null/undefined 不覆盖 */
export function mergeChatConfig<T extends object>(
  defaults: T,
  overrides: unknown,
): T {
  // 覆盖值来自配置文件，结构以默认值为准
  return mergeRecords(defaults, overrides) as T;
}

export function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  );
}

/** 兼容旧字段 imageAnalysisBlacklistUsers */
export function normalizeMediaAnalysisBlacklist(config: object): string[] {
  const current = isRecord(config)
    ? config.mediaAnalysisBlacklistUsers
    : undefined;
  const legacy = isRecord(config)
    ? config.imageAnalysisBlacklistUsers
    : undefined;
  const source =
    legacy !== undefined && Array.isArray(current) && current.length === 0
      ? legacy
      : (current ?? legacy);
  return normalizeIdList(source);
}
