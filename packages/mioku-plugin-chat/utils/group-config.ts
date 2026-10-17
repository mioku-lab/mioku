import type { ChatConfig, ChatGroupOverrides } from "../types";

const OVERRIDABLE_SUB_OBJECTS = [
  "emoji",
  "expression",
  "retention",
  "memory",
  "topic",
  "planner",
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

/**
 * 把每个群的覆盖配置浅合并到全局配置上
 * - 子对象（如 emoji）只覆盖其中存在的字段，未填字段继承全局
 * - 顶层布尔字段（enableMarkdownScreenshot 等）若覆盖中存在则整体替换
 * - 缺失字段、格式异常的覆盖会被静默忽略
 */
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
export function extractGroupIdFromSession(sessionId: string): string | undefined {
  if (!sessionId || typeof sessionId !== "string") return undefined;
  if (!sessionId.startsWith("group:")) return undefined;
  const raw = sessionId.slice("group:".length).trim();
  return raw.length > 0 ? raw : undefined;
}