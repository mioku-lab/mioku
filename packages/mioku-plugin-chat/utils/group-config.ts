import type { ChatConfig, ChatGroupOverrides } from "../types";

const OVERRIDABLE_SUB_OBJECTS = [
  "emoji",
  "expression",
  "retention",
  "topic",
  "audio",
  "searxng",
  "webReader",
  "dynamicDelay",
] as const;

const OVERRIDABLE_BOOLEAN_FIELDS = [
  "enableMarkdownScreenshot",
  "enableMediaRecognition",
] as const;

const OVERRIDABLE_ARRAY_FIELDS = ["allowedExternalSkills"] as const;

type SubObjectKey = (typeof OVERRIDABLE_SUB_OBJECTS)[number];

function mergeSubObject<K extends SubObjectKey>(
  result: ChatConfig,
  base: ChatConfig,
  key: K,
  override: ChatGroupOverrides[K],
): void {
  // 群配置来自文件，类型不可信
  if (!override || typeof override !== "object") return;
  const baseSub = base[key];
  if (baseSub && typeof baseSub === "object") {
    result[key] = { ...baseSub, ...override };
  }
}

export function mergeGroupOverrides(
  base: ChatConfig,
  overrides: ChatGroupOverrides | undefined | null,
): ChatConfig {
  if (!overrides || typeof overrides !== "object") return base;
  if (typeof base !== "object" || base === null) return base;

  const result: ChatConfig = { ...base };

  for (const key of OVERRIDABLE_SUB_OBJECTS) {
    mergeSubObject(result, base, key, overrides[key]);
  }

  for (const key of OVERRIDABLE_BOOLEAN_FIELDS) {
    const value = overrides[key];
    if (typeof value === "boolean") result[key] = value;
  }

  for (const key of OVERRIDABLE_ARRAY_FIELDS) {
    const value: unknown = overrides[key];
    if (Array.isArray(value)) {
      result[key] = value.filter((v): v is string => typeof v === "string");
    }
  }

  return result;
}

/**
 * 从 sessionId（如 "group:123"）提取群号，个人会话返回 undefined
 */
export function extractGroupIdFromSession(
  sessionId: string,
): string | undefined {
  if (!sessionId) return undefined;
  if (!sessionId.startsWith("group:")) return undefined;
  const raw = sessionId.slice("group:".length).trim();
  return raw.length > 0 ? raw : undefined;
}
