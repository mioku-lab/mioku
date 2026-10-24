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

export function mergeGroupOverrides(
  base: ChatConfig,
  overrides: ChatGroupOverrides | undefined | null,
): ChatConfig {
  if (!overrides || typeof overrides !== "object") return base;
  if (typeof base !== "object" || base === null) return base;

  const result: ChatConfig = { ...base };
  const resultMap = result as unknown as Record<string, unknown>;
  const overridesMap = overrides as Record<string, unknown>;

  for (const key of OVERRIDABLE_SUB_OBJECTS) {
    const overrideSub = overridesMap[key];
    if (overrideSub && typeof overrideSub === "object") {
      const baseSub = (base as unknown as Record<string, unknown>)[key];
      if (baseSub && typeof baseSub === "object") {
        resultMap[key] = {
          ...(baseSub as Record<string, unknown>),
          ...(overrideSub as Record<string, unknown>),
        };
      }
    }
  }

  for (const key of OVERRIDABLE_BOOLEAN_FIELDS) {
    const value = overridesMap[key];
    if (typeof value === "boolean") {
      resultMap[key] = value;
    }
  }

  for (const key of OVERRIDABLE_ARRAY_FIELDS) {
    const value = overridesMap[key];
    if (Array.isArray(value)) {
      resultMap[key] = value.filter((v) => typeof v === "string");
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
