import { MEMORY_CONFIG } from "../configs/memory";
import type { MemoryConfig } from "./types";

/** JSON 里 null / "" / true 都算「没填」，不能用 Number() 把它们变成 0 或 1 */
function toFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function num(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function frac(value: unknown, fallback: number): number {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const extractModel = value.extractModel === "main" ? "main" : "working";
  return {
    enabled: bool(value.enabled, MEMORY_CONFIG.enabled),
    extractModel,
    windowMinutes: num(
      value.windowMinutes,
      MEMORY_CONFIG.windowMinutes,
      1,
      1440,
    ),
    minMessagesPerWindow: num(
      value.minMessagesPerWindow,
      MEMORY_CONFIG.minMessagesPerWindow,
      1,
      500,
    ),
    maxBufferMessages: num(
      value.maxBufferMessages,
      MEMORY_CONFIG.maxBufferMessages,
      10,
      600,
    ),
    extractIntervalMs: num(
      value.extractIntervalMs,
      MEMORY_CONFIG.extractIntervalMs,
      30_000,
      24 * 60 * 60_000,
    ),
    maxCharsPerWindow: num(
      value.maxCharsPerWindow,
      MEMORY_CONFIG.maxCharsPerWindow,
      500,
      40_000,
    ),
    minConfidence: frac(value.minConfidence, MEMORY_CONFIG.minConfidence),
    maxItemsPerGroup: num(
      value.maxItemsPerGroup,
      MEMORY_CONFIG.maxItemsPerGroup,
      0,
      100_000,
    ),
    retentionMonths: num(
      value.retentionMonths,
      MEMORY_CONFIG.retentionMonths,
      1,
      240,
    ),
    injectTopK: num(value.injectTopK, MEMORY_CONFIG.injectTopK, 0, 50),
    injectMaxChars: num(
      value.injectMaxChars,
      MEMORY_CONFIG.injectMaxChars,
      0,
      8000,
    ),
    minRelevance: frac(value.minRelevance, MEMORY_CONFIG.minRelevance),
    injectTimeoutMs: num(
      value.injectTimeoutMs,
      MEMORY_CONFIG.injectTimeoutMs,
      50,
      5000,
    ),
    profileEnabled: bool(value.profileEnabled, MEMORY_CONFIG.profileEnabled),
    profileUpdateEvery: num(
      value.profileUpdateEvery,
      MEMORY_CONFIG.profileUpdateEvery,
      10,
      1000,
    ),
    recallToolsEnabled: bool(
      value.recallToolsEnabled,
      MEMORY_CONFIG.recallToolsEnabled,
    ),
    recallToolBudget: num(
      value.recallToolBudget,
      MEMORY_CONFIG.recallToolBudget,
      0,
      20,
    ),
    contextLookbackDays: num(
      value.contextLookbackDays,
      MEMORY_CONFIG.contextLookbackDays,
      1,
      3650,
    ),
    cacheTtlMs: num(value.cacheTtlMs, MEMORY_CONFIG.cacheTtlMs, 0, 60 * 60_000),
    indexMessages: bool(value.indexMessages, MEMORY_CONFIG.indexMessages),
    indexMessageMinChars: num(
      value.indexMessageMinChars,
      MEMORY_CONFIG.indexMessageMinChars,
      2,
      200,
    ),
    indexMessageRetentionDays: num(
      value.indexMessageRetentionDays,
      MEMORY_CONFIG.indexMessageRetentionDays,
      1,
      3650,
    ),
    sourceTraceback: bool(value.sourceTraceback, MEMORY_CONFIG.sourceTraceback),
    sourceTracebackLimit: num(
      value.sourceTracebackLimit,
      MEMORY_CONFIG.sourceTracebackLimit,
      1,
      20,
    ),
  };
}
