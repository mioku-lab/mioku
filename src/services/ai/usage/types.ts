export type AIUsageMessageRole = "system" | "user" | "assistant" | "tool";

export type AIUsageTokenCategory =
  | "system_prompt"
  | "tool_definition"
  | "tool_use"
  | "chat_history"
  | "other_context";

export type AIUsageScope = "all" | "bot";

export type AIUsageRange = "today" | "7d" | "30d";

export interface AIUsageContext {
  usageId?: string;
  source?: string;
  botId?: number;
  groupId?: number;
  groupName?: string;
  userId?: number;
  userName?: string;
  sessionId?: string;
}

export interface AIUsageBreakdown {
  systemPromptTokens?: number;
  chatHistoryTokens?: number;
  toolDefinitionTokens?: number;
  toolUseTokens?: number;
  otherContextTokens?: number;
}

export interface AIUsageFinalization {
  sentUserMessages?: number;
  sentAssistantMessages?: number;
  breakdown?: AIUsageBreakdown;
}

export interface AIUsageCompletionMeta {
  model: string;
  stream: boolean;
  success: boolean;
  errorMessage?: string;
  startedAt: number;
  endedAt: number;
  messages: Array<{
    role: AIUsageMessageRole;
    contentTokens: number;
  }>;
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

export interface AIUsageBotOption {
  botId: number;
  label: string;
}

export interface AIUsageSummary {
  generatedAt: number;
  range: AIUsageRange;
  scope: AIUsageScope;
  botId?: number;
  bots: AIUsageBotOption[];
  totals: {
    requests: number;
    successfulRequests: number;
    failedRequests: number;
    userMessages: number;
    assistantMessages: number;
    systemMessages: number;
    toolMessages: number;
    sentUserMessages: number;
    sentAssistantMessages: number;
    inputTokens: number;
    outputTokens: number;
    systemPromptTokens: number;
    totalTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    toolDefinitionTokens: number;
    toolUseTokens: number;
    chatHistoryTokens: number;
    otherContextTokens: number;
    durationMs: number;
    toolCalls: number;
  };
  rates: {
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  };
  toolRanking: Array<{
    name: string;
    count: number;
  }>;
  groupRanking: Array<{
    groupId: number;
    groupName: string;
    requests: number;
    totalTokens: number;
    userMessages: number;
    assistantMessages: number;
    errorRate: number;
  }>;
  tokenFlow: Array<{
    name: "输入" | "输出" | "缓存写入" | "缓存读取";
    value: number;
  }>;
  tokenCategories: Array<{
    name:
      | "系统提示词"
      | "工具定义"
      | "工具使用"
      | "聊天上下文"
      | "其他上下文";
    value: number;
  }>;
  dailyActivity: Array<{
    day: string;
    requests: number;
    userMessages: number;
    assistantMessages: number;
    totalTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  }>;
  hourlyActivity: Array<{
    hour: string;
    requests: number;
    userMessages: number;
    assistantMessages: number;
    totalTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  }>;
}

export interface AIUsageStore {
  record(record: AIUsageCompletionMeta): void;
  updateFinalization(usageId: string, finalization: AIUsageFinalization): boolean;
  getSummary(options: {
    range: AIUsageRange;
    botId?: number;
  }): AIUsageSummary;
  cleanup(retentionMs?: number): number;
  close(): void;
}
