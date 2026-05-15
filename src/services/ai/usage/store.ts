import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AIUsageCompletionMeta,
  AIUsageFinalization,
  AIUsageRange,
  AIUsageScope,
  AIUsageStore,
  AIUsageSummary,
} from "./types";

const DEFAULT_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BUFFER_SIZE = 50;

type UsageDatabase = ReturnType<typeof Database>;

interface UsageRow {
  id: number;
  source: string | null;
  usage_id: string | null;
  bot_id: number | null;
  group_id: number | null;
  group_name: string | null;
  user_id: number | null;
  user_name: string | null;
  session_id: string | null;
  model: string;
  stream: number;
  success: number;
  error_message: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  system_messages: number;
  user_messages: number;
  assistant_messages: number;
  tool_messages: number;
  sent_user_messages: number;
  sent_assistant_messages: number;
  input_tokens: number;
  output_tokens: number;
  system_prompt_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  tool_definition_tokens: number;
  tool_use_tokens: number;
  chat_history_tokens: number;
  other_context_tokens: number;
  total_tokens: number;
  tool_calls: string;
}

interface GroupAggregateRow {
  group_id: number | null;
  group_name: string | null;
  requests: number;
  total_tokens: number;
  user_messages: number;
  assistant_messages: number;
  sent_user_messages: number;
  sent_assistant_messages: number;
  failed_requests: number;
}

interface TimelineRow {
  bucket: string;
  requests: number;
  user_messages: number;
  assistant_messages: number;
  sent_user_messages: number;
  sent_assistant_messages: number;
  total_tokens: number;
  duration_ms: number;
  input_tokens: number;
  cache_read_tokens: number;
  failed_requests: number;
}

export function createAIUsageStore(): AIUsageStore {
  const dbDir = path.join(process.cwd(), "data", "ai");
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(path.join(dbDir, "usage.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      usage_id TEXT,
      bot_id INTEGER,
      group_id INTEGER,
      group_name TEXT,
      user_id INTEGER,
      user_name TEXT,
      session_id TEXT,
      model TEXT NOT NULL,
      stream INTEGER NOT NULL,
      success INTEGER NOT NULL,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      system_messages INTEGER NOT NULL,
      user_messages INTEGER NOT NULL,
      assistant_messages INTEGER NOT NULL,
      tool_messages INTEGER NOT NULL,
      sent_user_messages INTEGER NOT NULL DEFAULT 0,
      sent_assistant_messages INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      tool_definition_tokens INTEGER NOT NULL,
      tool_use_tokens INTEGER NOT NULL,
      chat_history_tokens INTEGER NOT NULL DEFAULT 0,
      other_context_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      tool_calls TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_ai_usage_started ON ai_usage_records(started_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_bot_started ON ai_usage_records(bot_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_group_started ON ai_usage_records(group_id, started_at);
  `);
  ensureColumn(
    db,
    "ai_usage_records",
    "system_prompt_tokens",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "ai_usage_records",
    "sent_user_messages",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "ai_usage_records",
    "sent_assistant_messages",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "ai_usage_records",
    "chat_history_tokens",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "ai_usage_records", "usage_id", "TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_ai_usage_usage_id ON ai_usage_records(usage_id)",
  );

  const insertRecord = db.prepare(`
    INSERT INTO ai_usage_records (
      source, usage_id, bot_id, group_id, group_name, user_id, user_name, session_id,
      model, stream, success, error_message, started_at, ended_at, duration_ms,
      system_messages, user_messages, assistant_messages, tool_messages,
      sent_user_messages, sent_assistant_messages,
      input_tokens, output_tokens, system_prompt_tokens, cache_write_tokens, cache_read_tokens,
      tool_definition_tokens, tool_use_tokens, chat_history_tokens, other_context_tokens,
      total_tokens, tool_calls
    )
    VALUES (
      @source, @usageId, @botId, @groupId, @groupName, @userId, @userName, @sessionId,
      @model, @stream, @success, @errorMessage, @startedAt, @endedAt, @durationMs,
      @systemMessages, @userMessages, @assistantMessages, @toolMessages,
      @sentUserMessages, @sentAssistantMessages,
      @inputTokens, @outputTokens, @systemPromptTokens, @cacheWriteTokens, @cacheReadTokens,
      @toolDefinitionTokens, @toolUseTokens, @chatHistoryTokens, @otherContextTokens,
      @totalTokens, @toolCalls
    )
  `);
  const insertMany = db.transaction((records: AIUsageCompletionMeta[]) => {
    for (const record of records) {
      const roleCounts = countRoles(record.messages);
      const totalTokens = Math.max(
        0,
        record.inputTokens +
          record.outputTokens +
          record.cacheWriteTokens +
          record.cacheReadTokens,
      );
      insertRecord.run({
        source: record.context?.source ?? null,
        usageId: record.context?.usageId ?? null,
        botId: record.context?.botId ?? null,
        groupId: record.context?.groupId ?? null,
        groupName: record.context?.groupName ?? null,
        userId: record.context?.userId ?? null,
        userName: record.context?.userName ?? null,
        sessionId: record.context?.sessionId ?? null,
        model: record.model,
        stream: record.stream ? 1 : 0,
        success: record.success ? 1 : 0,
        errorMessage: record.errorMessage ?? null,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: Math.max(0, record.endedAt - record.startedAt),
        systemMessages: roleCounts.system,
        userMessages: roleCounts.user,
        assistantMessages: roleCounts.assistant,
        toolMessages: roleCounts.tool,
        sentUserMessages: record.sentUserMessages,
        sentAssistantMessages: record.sentAssistantMessages,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        systemPromptTokens: record.systemPromptTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        cacheReadTokens: record.cacheReadTokens,
        toolDefinitionTokens: record.toolDefinitionTokens,
        toolUseTokens: record.toolUseTokens,
        chatHistoryTokens: record.chatHistoryTokens,
        otherContextTokens: record.otherContextTokens,
        totalTokens,
        toolCalls: JSON.stringify(record.toolCalls),
      });
    }
  });

  let buffer: AIUsageCompletionMeta[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const pending = buffer;
    buffer = [];
    insertMany(pending);
  };

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  const cleanupTimer = setInterval(() => {
    cleanup(DEFAULT_RETENTION_MS);
  }, CLEANUP_INTERVAL_MS);

  const cleanup = (retentionMs: number = DEFAULT_RETENTION_MS): number => {
    const before = Date.now() - retentionMs;
    const result = db
      .prepare("DELETE FROM ai_usage_records WHERE started_at < ?")
      .run(before);
    return Number(result.changes || 0);
  };

  const updateFinalization = (
    usageId: string,
    finalization: AIUsageFinalization,
  ): boolean => {
    flush();
    const breakdown = finalization.breakdown;
    const result = db
      .prepare(
        `
        UPDATE ai_usage_records
        SET
          sent_user_messages = COALESCE(@sentUserMessages, sent_user_messages),
          sent_assistant_messages = COALESCE(@sentAssistantMessages, sent_assistant_messages),
          system_prompt_tokens = COALESCE(@systemPromptTokens, system_prompt_tokens),
          chat_history_tokens = COALESCE(@chatHistoryTokens, chat_history_tokens),
          tool_definition_tokens = COALESCE(@toolDefinitionTokens, tool_definition_tokens),
          tool_use_tokens = COALESCE(@toolUseTokens, tool_use_tokens),
          other_context_tokens = COALESCE(@otherContextTokens, other_context_tokens)
        WHERE usage_id = @usageId
      `,
      )
      .run({
        usageId,
        sentUserMessages: normalizeOptionalCount(finalization.sentUserMessages),
        sentAssistantMessages: normalizeOptionalCount(
          finalization.sentAssistantMessages,
        ),
        systemPromptTokens: normalizeOptionalCount(
          breakdown?.systemPromptTokens,
        ),
        chatHistoryTokens: normalizeOptionalCount(
          breakdown?.chatHistoryTokens,
        ),
        toolDefinitionTokens: normalizeOptionalCount(
          breakdown?.toolDefinitionTokens,
        ),
        toolUseTokens: normalizeOptionalCount(breakdown?.toolUseTokens),
        otherContextTokens: normalizeOptionalCount(
          breakdown?.otherContextTokens,
        ),
      });
    return Number(result.changes || 0) > 0;
  };

  return {
    record(record: AIUsageCompletionMeta): void {
      buffer.push(record);
      if (buffer.length >= MAX_BUFFER_SIZE) {
        flush();
      }
    },
    getSummary(options): AIUsageSummary {
      flush();
      return buildSummary(db, options.range, options.botId);
    },
    updateFinalization,
    cleanup,
    close(): void {
      clearInterval(flushTimer);
      clearInterval(cleanupTimer);
      flush();
      db.close();
    },
  };
}

function buildSummary(
  db: UsageDatabase,
  range: AIUsageRange,
  botId?: number,
): AIUsageSummary {
  const startedAt = getRangeStart(range);
  const now = Date.now();
  const bots = getBotOptions(db, startedAt);
  const includeUnscoped = botId != null && bots.length === 1;
  const { whereSql, params, scope } = buildWhere(
    startedAt,
    botId,
    includeUnscoped,
  );
  const rows = db
    .prepare(`SELECT * FROM ai_usage_records ${whereSql}`)
    .all(params) as UsageRow[];

  const totals = rows.reduce(
    (acc, row) => {
      acc.requests += 1;
      acc.successfulRequests += row.success ? 1 : 0;
      acc.failedRequests += row.success ? 0 : 1;
      acc.userMessages += row.user_messages;
      acc.assistantMessages += row.assistant_messages;
      acc.systemMessages += row.system_messages;
      acc.toolMessages += row.tool_messages;
      acc.sentUserMessages += row.sent_user_messages;
      acc.sentAssistantMessages += row.sent_assistant_messages;
      acc.inputTokens += row.input_tokens;
      acc.outputTokens += row.output_tokens;
      acc.totalTokens += row.total_tokens;
      acc.systemPromptTokens += row.system_prompt_tokens;
      acc.cacheWriteTokens += row.cache_write_tokens;
      acc.cacheReadTokens += row.cache_read_tokens;
      acc.toolDefinitionTokens += row.tool_definition_tokens;
      acc.toolUseTokens += row.tool_use_tokens;
      acc.chatHistoryTokens += row.chat_history_tokens;
      acc.otherContextTokens += row.other_context_tokens;
      acc.durationMs += row.duration_ms;
      acc.toolCalls += parseToolCalls(row.tool_calls).length;
      return acc;
    },
    {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      userMessages: 0,
      assistantMessages: 0,
      systemMessages: 0,
      toolMessages: 0,
      sentUserMessages: 0,
      sentAssistantMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      systemPromptTokens: 0,
      toolDefinitionTokens: 0,
      toolUseTokens: 0,
      chatHistoryTokens: 0,
      otherContextTokens: 0,
      durationMs: 0,
      toolCalls: 0,
    },
  );

  return {
    generatedAt: Date.now(),
    range,
    scope,
    botId,
    bots,
    totals,
    rates: {
      throughputTokPerMin:
        totals.requests > 0
          ? getTokenConsumptionRate(totals.totalTokens, startedAt, now)
          : 0,
      averageTokensPerUserMessage: getAverageTokensPerUserMessage(
        totals.totalTokens,
        totals.userMessages,
      ),
      averageTokensPerSentMessage: getAverageTokensPerUserMessage(
        totals.totalTokens,
        totals.requests,
      ),
      errorRate:
        totals.requests > 0
          ? round(totals.failedRequests / totals.requests, 4)
          : 0,
      cacheHitRate: getCacheHitRate(totals.cacheReadTokens, totals.inputTokens),
    },
    toolRanking: buildToolRanking(rows),
    groupRanking: getGroupRanking(db, whereSql, params),
    tokenFlow: [
      { name: "输入", value: totals.inputTokens },
      { name: "输出", value: totals.outputTokens },
      { name: "缓存写入", value: totals.cacheWriteTokens },
      { name: "缓存读取", value: totals.cacheReadTokens },
    ],
    tokenCategories: [
      { name: "系统提示词", value: totals.systemPromptTokens },
      { name: "工具定义", value: totals.toolDefinitionTokens },
      { name: "工具使用", value: totals.toolUseTokens },
      { name: "聊天上下文", value: totals.chatHistoryTokens },
      { name: "其他上下文", value: totals.otherContextTokens },
    ],
    dailyActivity: getDailyActivity(db, whereSql, params, now),
    hourlyActivity: getHourlyActivity(db, whereSql, params, now),
  };
}

function getRangeStart(range: AIUsageRange): number {
  const now = new Date();
  if (range === "today") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
  }
  const days = range === "7d" ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function buildWhere(
  startedAt: number,
  botId: number | undefined,
  includeUnscopedBotRecords: boolean = false,
): {
  whereSql: string;
  params: Record<string, number>;
  scope: AIUsageScope;
} {
  const params: Record<string, number> = { startedAt };
  const conditions = ["started_at >= @startedAt"];
  if (botId != null) {
    params.botId = botId;
    conditions.push(
      includeUnscopedBotRecords
        ? "(bot_id = @botId OR bot_id IS NULL)"
        : "bot_id = @botId",
    );
  }
  return {
    whereSql: `WHERE ${conditions.join(" AND ")}`,
    params,
    scope: botId == null ? "all" : "bot",
  };
}

function countRoles(
  messages: AIUsageCompletionMeta["messages"],
): Record<"system" | "user" | "assistant" | "tool", number> {
  return messages.reduce(
    (acc, message) => {
      acc[message.role] += 1;
      return acc;
    },
    { system: 0, user: 0, assistant: 0, tool: 0 },
  );
}

function ensureColumn(
  db: UsageDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function getBotOptions(
  db: UsageDatabase,
  startedAt: number,
): AIUsageSummary["bots"] {
  const rows = db
    .prepare(
      `
      SELECT bot_id, COUNT(*) as requests
      FROM ai_usage_records
      WHERE started_at >= ? AND bot_id IS NOT NULL
      GROUP BY bot_id
      ORDER BY requests DESC
    `,
    )
    .all(startedAt) as Array<{ bot_id: number; requests: number }>;
  return rows.map((row) => ({
    botId: row.bot_id,
    label: `${row.bot_id}`,
  }));
}

function buildToolRanking(rows: UsageRow[]): AIUsageSummary["toolRanking"] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of parseToolCalls(row.tool_calls)) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function getGroupRanking(
  db: UsageDatabase,
  whereSql: string,
  params: Record<string, number>,
): AIUsageSummary["groupRanking"] {
  const rows = db
    .prepare(
      `
      SELECT
        group_id,
        COALESCE(NULLIF(TRIM(group_name), ''), CAST(group_id AS TEXT), '私聊') as group_name,
        COUNT(*) as requests,
        SUM(total_tokens) as total_tokens,
        SUM(user_messages) as user_messages,
        SUM(assistant_messages) as assistant_messages,
        SUM(sent_user_messages) as sent_user_messages,
        SUM(sent_assistant_messages) as sent_assistant_messages,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests
      FROM ai_usage_records
      ${whereSql}
      GROUP BY group_id, group_name
      ORDER BY total_tokens DESC
      LIMIT 12
    `,
    )
    .all(params) as GroupAggregateRow[];

  return rows
    .filter((row) => row.group_id != null)
    .map((row) => ({
      groupId: Number(row.group_id),
      groupName: row.group_name || String(row.group_id),
      requests: Number(row.requests || 0),
      totalTokens: Number(row.total_tokens || 0),
      userMessages: Number(row.user_messages || 0),
      assistantMessages: Number(row.assistant_messages || 0),
      errorRate:
        Number(row.requests || 0) > 0
          ? round(Number(row.failed_requests || 0) / Number(row.requests), 4)
          : 0,
    }));
}

function getDailyActivity(
  db: UsageDatabase,
  whereSql: string,
  params: Record<string, number>,
  now: number,
): AIUsageSummary["dailyActivity"] {
  const rows = db
    .prepare(
      `
      SELECT
        strftime('%Y-%m-%d', datetime(started_at / 1000, 'unixepoch', 'localtime')) as bucket,
        COUNT(*) as requests,
        SUM(user_messages) as user_messages,
        SUM(assistant_messages) as assistant_messages,
        SUM(sent_user_messages) as sent_user_messages,
        SUM(sent_assistant_messages) as sent_assistant_messages,
        SUM(total_tokens) as total_tokens,
        SUM(duration_ms) as duration_ms,
        SUM(input_tokens) as input_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests
      FROM ai_usage_records
      ${whereSql}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    )
    .all(params) as TimelineRow[];

  return rows.map((row) => ({
    day: row.bucket,
    requests: Number(row.requests || 0),
    userMessages: Number(row.user_messages || 0),
    assistantMessages: Number(row.assistant_messages || 0),
    totalTokens: Number(row.total_tokens || 0),
    inputTokens: Number(row.input_tokens || 0),
    cacheReadTokens: Number(row.cache_read_tokens || 0),
    throughputTokPerMin: getTokenConsumptionRate(
      Number(row.total_tokens || 0),
      getLocalDateBucketStart(row.bucket),
      now,
      24 * 60 * 60 * 1000,
    ),
    averageTokensPerUserMessage: getAverageTokensPerUserMessage(
      Number(row.total_tokens || 0),
      Number(row.user_messages || 0),
    ),
    averageTokensPerSentMessage: getAverageTokensPerUserMessage(
      Number(row.total_tokens || 0),
      Number(row.requests || 0),
    ),
    errorRate:
      Number(row.requests || 0) > 0
        ? round(Number(row.failed_requests || 0) / Number(row.requests), 4)
        : 0,
    cacheHitRate: getCacheHitRate(
      Number(row.cache_read_tokens || 0),
      Number(row.input_tokens || 0),
    ),
  }));
}

function getHourlyActivity(
  db: UsageDatabase,
  whereSql: string,
  params: Record<string, number>,
  now: number,
): AIUsageSummary["hourlyActivity"] {
  const rows = db
    .prepare(
      `
      SELECT
        strftime('%H:00', datetime(started_at / 1000, 'unixepoch', 'localtime')) as bucket,
        COUNT(*) as requests,
        SUM(user_messages) as user_messages,
        SUM(assistant_messages) as assistant_messages,
        SUM(sent_user_messages) as sent_user_messages,
        SUM(sent_assistant_messages) as sent_assistant_messages,
        SUM(total_tokens) as total_tokens,
        SUM(duration_ms) as duration_ms,
        SUM(input_tokens) as input_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests
      FROM ai_usage_records
      ${whereSql}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    )
    .all(params) as TimelineRow[];

  return rows.map((row) => ({
    hour: row.bucket,
    requests: Number(row.requests || 0),
    userMessages: Number(row.user_messages || 0),
    assistantMessages: Number(row.assistant_messages || 0),
    totalTokens: Number(row.total_tokens || 0),
    inputTokens: Number(row.input_tokens || 0),
    cacheReadTokens: Number(row.cache_read_tokens || 0),
    throughputTokPerMin: getTokenConsumptionRate(
      Number(row.total_tokens || 0),
      getLocalHourBucketStart(row.bucket, now),
      now,
      60 * 60 * 1000,
    ),
    averageTokensPerUserMessage: getAverageTokensPerUserMessage(
      Number(row.total_tokens || 0),
      Number(row.user_messages || 0),
    ),
    averageTokensPerSentMessage: getAverageTokensPerUserMessage(
      Number(row.total_tokens || 0),
      Number(row.requests || 0),
    ),
    errorRate:
      Number(row.requests || 0) > 0
        ? round(Number(row.failed_requests || 0) / Number(row.requests), 4)
        : 0,
    cacheHitRate: getCacheHitRate(
      Number(row.cache_read_tokens || 0),
      Number(row.input_tokens || 0),
    ),
  }));
}

function getTokenConsumptionRate(
  totalTokens: number,
  bucketStart: number,
  now: number,
  maxDurationMs?: number,
): number {
  const bucketDurationMs = Math.max(1000, now - bucketStart);
  const durationMs =
    maxDurationMs == null
      ? bucketDurationMs
      : Math.min(maxDurationMs, bucketDurationMs);
  return round(totalTokens / (durationMs / 1000), 2);
}

function getLocalDateBucketStart(day: string): number {
  return new Date(`${day}T00:00:00`).getTime();
}

function getLocalHourBucketStart(hour: string, now: number): number {
  const date = new Date(now);
  const hourNumber = Number(hour.slice(0, 2));
  date.setHours(Number.isFinite(hourNumber) ? hourNumber : 0, 0, 0, 0);
  return date.getTime();
}

function getAverageTokensPerUserMessage(
  totalTokens: number,
  userMessageCount: number,
): number {
  return userMessageCount > 0 ? round(totalTokens / userMessageCount, 2) : 0;
}

function getCacheHitRate(cacheReadTokens: number, inputTokens: number): number {
  if (cacheReadTokens <= 0) return 0;
  if (inputTokens > 0) {
    return round(Math.min(1, cacheReadTokens / inputTokens), 4);
  }
  return 0;
}

function parseToolCalls(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function normalizeOptionalCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
