import type { MemoryConfig } from "../memory/types";

/**
 * 群聊记忆默认值。
 *
 * 写入走后台工作模型（异步、不挡消息主路径），读取走「轮廓直读 + 向量检索」，
 * 注入块只进动态上下文，永远不碰 system 提示词与历史消息，避免击穿前缀缓存。
 *
 * 预算按线上近 7 天数据留余量：注入最坏 10 条记忆 + 画像约 3.6k 字；
 * 抽取最坏的 480 条批次约 28k 字，取 32k。
 */
export const MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  extractModel: "working",
  windowMinutes: 30,
  minMessagesPerWindow: 12,
  maxBufferMessages: 480,
  extractIntervalMs: 5 * 60_000,
  maxCharsPerWindow: 32_000,
  minConfidence: 0.55,
  maxItemsPerGroup: 8000,
  retentionMonths: 3,
  injectTopK: 10,
  injectMaxChars: 4000,
  minRelevance: 0.45,
  injectTimeoutMs: 1000,
  profileEnabled: true,
  profileUpdateEvery: 40,
  recallToolsEnabled: true,
  recallToolBudget: 5,
  contextLookbackDays: 30,
  cacheTtlMs: 90_000,
  indexMessages: false,
  indexMessageMinChars: 8,
  indexMessageRetentionDays: 14,
  sourceTraceback: true,
  sourceTracebackLimit: 3,
};
