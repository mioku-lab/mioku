import type {
  AIUsageBreakdown,
  AIUsageContext,
  AIUsageFinalization,
  AIUsageBotOption,
  AIUsageRange,
  AIUsageRecordQuery,
  AIUsageRecordSummary,
  AIUsageScope,
  AIUsageSummary,
} from "mioku";

export type {
  AIUsageBreakdown,
  AIUsageContext,
  AIUsageFinalization,
  AIUsageBotOption,
  AIUsageRange,
  AIUsageRecordQuery,
  AIUsageRecordSummary,
  AIUsageScope,
  AIUsageSummary,
};

export type AIUsageMessageRole = "system" | "user" | "assistant" | "tool";

export type AIUsageTokenCategory =
  | "system_prompt"
  | "tool_definition"
  | "tool_use"
  | "chat_history"
  | "other_context";

export interface AIUsageCompletionMeta {
  model: string;
  stream: boolean;
  success: boolean;
  errorMessage?: string;
  startedAt: number;
  endedAt: number;
  messages: Array<{ role: AIUsageMessageRole; contentTokens: number }>;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  sentUserMessages: number;
  sentAssistantMessages: number;
  systemPromptTokens: number;
  toolDefinitionTokens: number;
  toolUseTokens: number;
  chatHistoryTokens: number;
  otherContextTokens: number;
  toolCalls: string[];
  context?: AIUsageContext;
}

export interface AIUsageMeasuredTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface AIUsageRecord extends AIUsageCompletionMeta {
  id?: number;
}

export interface AIUsageStore {
  record(record: AIUsageCompletionMeta): void;
  updateFinalization(usageId: string, finalization: AIUsageFinalization): boolean;
  getSummary(options: { range: AIUsageRange; botId?: number }): AIUsageSummary;
  listRecords(options: AIUsageRecordQuery): AIUsageRecordSummary[];
  cleanup(retentionMs?: number): number;
  close(): void;
}
