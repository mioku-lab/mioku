import { Database } from "bun:sqlite";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import type {
  SessionMeta,
  ChatMessage,
  TopicRecord,
  GroupEventKind,
  GroupEventRecord,
  ImageRecord,
  MediaSummaryRecord,
} from "./types";

function toChatMessage(row: any): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    userTitle: row.user_title,
    groupId: row.group_id,
    groupName: row.group_name,
    timestamp: row.timestamp,
    messageId: row.message_id != null ? String(row.message_id) : undefined,
  };
}

function toTopicRecord(row: any): TopicRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    keywords: row.keywords,
    summary: row.summary,
    messageCount: row.message_count,
    windowStartAt: row.window_start_at ?? undefined,
    windowEndAt: row.window_end_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGroupEventRecord(row: any): GroupEventRecord {
  return {
    id: row.id,
    groupId: String(row.group_id ?? ""),
    kind: row.kind,
    userId: row.user_id == null ? undefined : String(row.user_id),
    userName: row.user_name ?? undefined,
    targetId: row.target_id == null ? undefined : String(row.target_id),
    targetName: row.target_name ?? undefined,
    content: row.content ?? undefined,
    eventKey: row.event_key ?? undefined,
    timestamp: row.timestamp,
  };
}

/**
 * 聊天数据库接口
 */
export interface ChatDatabase {
  saveSession(meta: SessionMeta): void;
  getSession(id: string): SessionMeta | null;
  saveMessage(msg: ChatMessage): void;
  getMessages(
    sessionId: string,
    limit?: number,
    before?: number,
  ): ChatMessage[];
  // 获取 bot 发送的消息
  getBotMessages(groupId: string, limit?: number): ChatMessage[];
  /** 按平台 message_id 回查一条消息（撤回原文还原用） */
  getMessageByMessageId(messageId: string): ChatMessage | null;
  getMessagesByUser(
    userId: string,
    sessionId?: string,
    limit?: number,
  ): ChatMessage[];
  getAllMessagesByUser(userId: string, sessionId?: string): ChatMessage[];
  getMessagesByTimeRange(
    sessionId: string,
    startTimestamp: number,
    endTimestamp: number,
  ): ChatMessage[];
  updateCompressedContext(sessionId: string, context: string): void;
  deleteSessionMessages(sessionId: string): void;
  // 删除 bot 发送的消息
  deleteBotMessages(sessionId: string): void;
  // 话题
  saveTopic(topic: TopicRecord): number;
  getTopics(sessionId: string, limit?: number): TopicRecord[];
  getTopicByWindow(
    sessionId: string,
    windowStartAt: number,
    windowEndAt: number,
  ): TopicRecord | null;
  updateTopic(
    id: number,
    updates: Partial<
      Pick<TopicRecord, "summary" | "keywords" | "messageCount" | "updatedAt">
    >,
  ): void;
  // 群事件（撤回 / 进退群 / 拍一拍）
  saveGroupEvent(event: GroupEventRecord): void;
  hasGroupEvent(eventKey: string): boolean;
  getGroupEvents(groupId: string, since: number, limit?: number): GroupEventRecord[];
  getGroupEventsByKind(
    groupId: string,
    kind: GroupEventKind,
    since: number,
    limit?: number,
  ): GroupEventRecord[];
  pruneGroupEventsOlderThan(timestamp: number): number;
  pruneMessagesOlderThan(timestamp: number): number;
  pruneTopicsOlderThan(timestamp: number): number;
  pruneMediaSummariesOlderThan(timestamp: number): number;
  pruneImagesOlderThan(timestamp: number): number;
  // 图片记录
  saveImage(image: ImageRecord): void;
  getImageByHash(hash: string): ImageRecord | null;
  getImageByUrl(url: string): ImageRecord | null;
  getAllImages(): ImageRecord[];
  // 媒体/卡片摘要缓存
  saveMediaSummary(summary: MediaSummaryRecord): void;
  getMediaSummary(key: string): MediaSummaryRecord | null;
  saveMediaSummarySource(sourceKey: string, summaryKey: string): void;
  getMediaSummaryBySource(sourceKey: string): MediaSummaryRecord | null;
  close(): void;
}

/**
 * SQLite 数据库实现
 */
export async function initDatabase(): Promise<ChatDatabase> {
  const dbDir = path.join(process.cwd(), "data", "chat");
  if (!existsSync(dbDir)) {
    await fs.mkdir(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, "chat.db");
  const db = new Database(dbPath);

  // 开启 WAL 模式提升并发性能
  db.exec("PRAGMA journal_mode = WAL");

  // 创建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      compressed_context TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      user_id INTEGER,
      user_name TEXT,
      user_role TEXT,
      user_title TEXT,
      group_id INTEGER,
      group_name TEXT,
      timestamp INTEGER NOT NULL,
      message_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(session_id, content);

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      window_start_at INTEGER,
      window_end_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_session ON topics(session_id, updated_at);

    CREATE TABLE IF NOT EXISTS group_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      target_id TEXT,
      target_name TEXT,
      content TEXT,
      event_key TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_events_group ON group_events(group_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_group_events_kind ON group_events(group_id, kind, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_events_key ON group_events(event_key);

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      emotion TEXT,
      character TEXT,
      file_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);
    CREATE INDEX IF NOT EXISTS idx_images_type ON images(type);

    CREATE TABLE IF NOT EXISTS media_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_summaries_key ON media_summaries(key);
    CREATE INDEX IF NOT EXISTS idx_media_summaries_kind ON media_summaries(kind);

    CREATE TABLE IF NOT EXISTS media_summary_sources (
      source_key TEXT PRIMARY KEY,
      summary_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_summary_sources_summary ON media_summary_sources(summary_key);
  `);

  const topicColumns = db
    .prepare("PRAGMA table_info(topics)")
    .all() as Array<{ name: string }>;
  const hasWindowStartAt = topicColumns.some(
    (column) => column.name === "window_start_at",
  );
  const hasWindowEndAt = topicColumns.some(
    (column) => column.name === "window_end_at",
  );
  if (!hasWindowStartAt) {
    db.exec("ALTER TABLE topics ADD COLUMN window_start_at INTEGER");
  }
  if (!hasWindowEndAt) {
    db.exec("ALTER TABLE topics ADD COLUMN window_end_at INTEGER");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_topics_session_window ON topics(session_id, window_end_at)",
  );

  // 清理已移除功能的遗留表。
  // 「表达学习」改成了即时采样（见 humanize/style-samples.ts），结果不再落库，
  // 这张表留着只会让人以为还有一份历史数据在生效。
  db.exec("DROP TABLE IF EXISTS expressions");

  // 预编译语句
  const stmts = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, type, target_id, created_at, updated_at, compressed_context)
      VALUES ($id, $type, $targetId, $createdAt, $updatedAt, $compressedContext)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = $updatedAt,
        compressed_context = COALESCE($compressedContext, compressed_context)
    `),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
    insertMessage: db.prepare(`
      INSERT INTO messages (session_id, role, content, user_id, user_name, user_role, user_title, group_id, group_name, timestamp, message_id)
      VALUES ($sessionId, $role, $content, $userId, $userName, $userRole, $userTitle, $groupId, $groupName, $timestamp, $messageId)
    `),
    getMessages: db.prepare(`
      SELECT * FROM messages WHERE session_id = $sessionId ORDER BY timestamp DESC, id DESC LIMIT $limit
    `),
    getMessagesBefore: db.prepare(`
      SELECT * FROM messages WHERE session_id = $sessionId AND timestamp < $timestamp ORDER BY timestamp DESC, id DESC LIMIT $limit
    `),
    getBotMessages: db.prepare(`
      SELECT * FROM messages WHERE group_id = $groupId AND role = 'assistant' ORDER BY timestamp DESC LIMIT $limit
    `),
    getMessageByMessageId: db.prepare(`
      SELECT * FROM messages WHERE message_id = $messageId ORDER BY timestamp DESC LIMIT 1
    `),
    getMessagesByUser: db.prepare(`
      SELECT * FROM messages WHERE user_id = $userId ORDER BY timestamp DESC LIMIT $limit
    `),
    getAllMessagesByUser: db.prepare(`
      SELECT * FROM messages WHERE user_id = $userId ORDER BY timestamp DESC, id DESC
    `),
    getMessagesByUserInSession: db.prepare(`
      SELECT * FROM messages WHERE user_id = $userId AND session_id = $sessionId ORDER BY timestamp DESC LIMIT $limit
    `),
    getAllMessagesByUserInSession: db.prepare(`
      SELECT * FROM messages WHERE user_id = $userId AND session_id = $sessionId ORDER BY timestamp DESC, id DESC
    `),
    getMessagesByTimeRange: db.prepare(`
      SELECT * FROM messages
      WHERE session_id = $sessionId AND timestamp >= $startTimestamp AND timestamp < $endTimestamp
      ORDER BY timestamp ASC, id ASC
    `),
    updateCompressedContext: db.prepare(`
      UPDATE sessions SET compressed_context = $compressedContext, updated_at = $updatedAt WHERE id = $sessionId
    `),
    deleteSessionMessages: db.prepare(`
      DELETE FROM messages WHERE session_id = $sessionId
    `),
    deleteBotMessages: db.prepare(`
      DELETE FROM messages WHERE session_id = $sessionId AND role = 'assistant'
    `),
    resetSessionContext: db.prepare(`
      UPDATE sessions SET compressed_context = NULL, updated_at = $updatedAt WHERE id = $sessionId
    `),
    // 话题
    insertTopic: db.prepare(`
      INSERT INTO topics (session_id, title, keywords, summary, message_count, window_start_at, window_end_at, created_at, updated_at)
      VALUES ($sessionId, $title, $keywords, $summary, $messageCount, $windowStartAt, $windowEndAt, $createdAt, $updatedAt)
    `),
    getTopics: db.prepare(`
      SELECT * FROM topics WHERE session_id = $sessionId ORDER BY updated_at DESC LIMIT $limit
    `),
    getTopicByWindow: db.prepare(`
      SELECT * FROM topics
      WHERE session_id = $sessionId AND window_start_at = $windowStartAt AND window_end_at = $windowEndAt
      ORDER BY id DESC
      LIMIT 1
    `),
    updateTopic: db.prepare(`
      UPDATE topics SET summary = $summary, keywords = $keywords, message_count = $messageCount, updated_at = $updatedAt WHERE id = $id
    `),
    // 群事件（撤回 / 进退群 / 拍一拍）
    insertGroupEvent: db.prepare(`
      INSERT OR IGNORE INTO group_events
        (group_id, kind, user_id, user_name, target_id, target_name, content, event_key, timestamp)
      VALUES
        ($groupId, $kind, $userId, $userName, $targetId, $targetName, $content, $eventKey, $timestamp)
    `),
    hasGroupEvent: db.prepare(`
      SELECT 1 FROM group_events WHERE event_key = $eventKey LIMIT 1
    `),
    getGroupEvents: db.prepare(`
      SELECT * FROM group_events
      WHERE group_id = $groupId AND timestamp >= $since
      ORDER BY timestamp DESC LIMIT $limit
    `),
    getGroupEventsByKind: db.prepare(`
      SELECT * FROM group_events
      WHERE group_id = $groupId AND kind = $kind AND timestamp >= $since
      ORDER BY timestamp DESC LIMIT $limit
    `),
    pruneGroupEvents: db.prepare(`
      DELETE FROM group_events WHERE timestamp < $before
    `),
    pruneMessages: db.prepare(`
      DELETE FROM messages WHERE timestamp < $before
    `),
    pruneTopics: db.prepare(`
      DELETE FROM topics WHERE created_at < $before
    `),
    pruneMediaSummaries: db.prepare(`
      DELETE FROM media_summaries WHERE created_at < $before
    `),
    pruneMediaSummarySources: db.prepare(`
      DELETE FROM media_summary_sources WHERE created_at < $before
    `),
    pruneImages: db.prepare(`
      DELETE FROM images WHERE created_at < $before
    `),
    // 图片记录
    insertImage: db.prepare(`
      INSERT INTO images (hash, url, type, description, emotion, character, file_path, created_at)
      VALUES ($hash, $url, $type, $description, $emotion, $character, $filePath, $createdAt)
      ON CONFLICT(hash) DO UPDATE SET
        url = excluded.url,
        type = excluded.type,
        description = excluded.description,
        emotion = excluded.emotion,
        character = excluded.character,
        file_path = excluded.file_path,
        created_at = excluded.created_at
    `),
    getImageByHash: db.prepare(`SELECT * FROM images WHERE hash = $hash`),
    getImageByUrl: db.prepare(`SELECT * FROM images WHERE url = $url`),
    getAllImages: db.prepare(`SELECT * FROM images ORDER BY created_at DESC`),
    upsertMediaSummary: db.prepare(`
      INSERT INTO media_summaries (key, kind, source, summary, created_at)
      VALUES ($key, $kind, $source, $summary, $createdAt)
      ON CONFLICT(key) DO UPDATE SET
        summary = $summary,
        source = $source,
        created_at = $createdAt
    `),
    getMediaSummary: db.prepare(`SELECT * FROM media_summaries WHERE key = $key`),
    upsertMediaSummarySource: db.prepare(`
      INSERT INTO media_summary_sources (source_key, summary_key, created_at)
      VALUES ($sourceKey, $summaryKey, $createdAt)
      ON CONFLICT(source_key) DO UPDATE SET
        summary_key = $summaryKey,
        created_at = $createdAt
    `),
    getMediaSummaryBySource: db.prepare(`
      SELECT s.*
      FROM media_summary_sources src
      JOIN media_summaries s ON s.key = src.summary_key
      WHERE src.source_key = $sourceKey
    `),
  };

  return {
    saveSession(meta: SessionMeta): void {
      stmts.upsertSession.run({
        $id: meta.id,
        $type: meta.type,
        $targetId: meta.targetId,
        $createdAt: meta.createdAt,
        $updatedAt: meta.updatedAt,
        $compressedContext: meta.compressedContext,
      });
    },

    getSession(id: string): SessionMeta | null {
      const row = stmts.getSession.get({ $id: id }) as any;
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        targetId: row.target_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        compressedContext: row.compressed_context,
      };
    },

    saveMessage(msg: ChatMessage): void {
      stmts.insertMessage.run({
        $sessionId: msg.sessionId,
        $role: msg.role,
        $content: msg.content,
        $userId: msg.userId ?? null,
        $userName: msg.userName ?? null,
        $userRole: msg.userRole ?? null,
        $userTitle: msg.userTitle ?? null,
        $groupId: msg.groupId ?? null,
        $groupName: msg.groupName ?? null,
        $timestamp: msg.timestamp,
        $messageId:
          msg.messageId == null || msg.messageId === ""
            ? null
            : String(msg.messageId),
      });
    },

    getMessages(
      sessionId: string,
      limit: number = 30,
      before?: number,
    ): ChatMessage[] {
      const rows = before
        ? (stmts.getMessagesBefore.all({ $sessionId: sessionId, $timestamp: before, $limit: limit }) as any[])
        : (stmts.getMessages.all({ $sessionId: sessionId, $limit: limit }) as any[]);

      return rows
        .map(toChatMessage)
        .reverse(); // 按时间正序
    },

    getBotMessages(groupId: string, limit: number = 50): ChatMessage[] {
      const rows = stmts.getBotMessages.all({ $groupId: groupId, $limit: limit }) as any[];
      return rows
        .map(toChatMessage)
        .reverse(); // 按时间正序
    },

    getMessageByMessageId(messageId: string): ChatMessage | null {
      if (!messageId) return null;
      const row = stmts.getMessageByMessageId.get({ $messageId: messageId }) as any;
      return row ? toChatMessage(row) : null;
    },

    getMessagesByUser(
      userId: string,
      sessionId?: string,
      limit: number = 20,
    ): ChatMessage[] {      const rows = sessionId
        ? (stmts.getMessagesByUserInSession.all({
            $userId: userId,
            $sessionId: sessionId,
            $limit: limit,
          }) as any[])
        : (stmts.getMessagesByUser.all({ $userId: userId, $limit: limit }) as any[]);

      return rows
        .map(toChatMessage)
        .reverse();
    },

    getAllMessagesByUser(userId: string, sessionId?: string): ChatMessage[] {
      const rows = sessionId
        ? (stmts.getAllMessagesByUserInSession.all({ $userId: userId, $sessionId: sessionId }) as any[])
        : (stmts.getAllMessagesByUser.all({ $userId: userId }) as any[]);

      return rows
        .map(toChatMessage)
        .reverse();
    },

    getMessagesByTimeRange(
      sessionId: string,
      startTimestamp: number,
      endTimestamp: number,
    ): ChatMessage[] {
      const rows = stmts.getMessagesByTimeRange.all({
        $sessionId: sessionId,
        $startTimestamp: startTimestamp,
        $endTimestamp: endTimestamp,
      }) as any[];
      return rows.map(toChatMessage);
    },

    updateCompressedContext(sessionId: string, context: string): void {
      stmts.updateCompressedContext.run({ $compressedContext: context, $updatedAt: Date.now(), $sessionId: sessionId });
    },

    deleteSessionMessages(sessionId: string): void {
      stmts.deleteSessionMessages.run({ $sessionId: sessionId });
      stmts.resetSessionContext.run({ $updatedAt: Date.now(), $sessionId: sessionId });
    },

    deleteBotMessages(sessionId: string): void {
      stmts.deleteBotMessages.run({ $sessionId: sessionId });
    },

    saveTopic(topic: TopicRecord): number {
      const result = stmts.insertTopic.run({
        $sessionId: topic.sessionId,
        $title: topic.title,
        $keywords: topic.keywords,
        $summary: topic.summary,
        $messageCount: topic.messageCount,
        $windowStartAt: topic.windowStartAt ?? null,
        $windowEndAt: topic.windowEndAt ?? null,
        $createdAt: topic.createdAt,
        $updatedAt: topic.updatedAt,
      });
      return Number(result.lastInsertRowid);
    },

    getTopics(sessionId: string, limit: number = 10): TopicRecord[] {
      const rows = stmts.getTopics.all({ $sessionId: sessionId, $limit: limit }) as any[];
      return rows.map(toTopicRecord);
    },

    getTopicByWindow(
      sessionId: string,
      windowStartAt: number,
      windowEndAt: number,
    ): TopicRecord | null {
      const row = stmts.getTopicByWindow.get({
        $sessionId: sessionId,
        $windowStartAt: windowStartAt,
        $windowEndAt: windowEndAt,
      }) as any;
      if (!row) return null;
      return toTopicRecord(row);
    },

    updateTopic(
      id: number,
      updates: Partial<
        Pick<TopicRecord, "summary" | "keywords" | "messageCount" | "updatedAt">
      >,
    ): void {
      // 先获取当前值用于合并
      const current = db
        .prepare("SELECT * FROM topics WHERE id = $id")
        .get({ $id: id }) as any;
      if (!current) return;
      stmts.updateTopic.run({
        $id: id,
        $summary: updates.summary ?? current.summary,
        $keywords: updates.keywords ?? current.keywords,
        $messageCount: updates.messageCount ?? current.message_count,
        $updatedAt: updates.updatedAt ?? Date.now(),
      });
    },

    saveGroupEvent(event: GroupEventRecord): void {
      stmts.insertGroupEvent.run({
        $groupId: event.groupId,
        $kind: event.kind,
        $userId: event.userId ?? null,
        $userName: event.userName ?? null,
        $targetId: event.targetId ?? null,
        $targetName: event.targetName ?? null,
        $content: event.content ?? null,
        $eventKey: event.eventKey ?? null,
        $timestamp: event.timestamp,
      });
    },

    hasGroupEvent(eventKey: string): boolean {
      if (!eventKey) return false;
      return Boolean(stmts.hasGroupEvent.get({ $eventKey: eventKey }));
    },

    getGroupEvents(
      groupId: string,
      since: number,
      limit: number = 200,
    ): GroupEventRecord[] {
      const rows = stmts.getGroupEvents.all({
        $groupId: groupId,
        $since: since,
        $limit: limit,
      }) as any[];
      return rows.map(toGroupEventRecord).reverse();
    },

    getGroupEventsByKind(
      groupId: string,
      kind: GroupEventKind,
      since: number,
      limit: number = 50,
    ): GroupEventRecord[] {
      const rows = stmts.getGroupEventsByKind.all({
        $groupId: groupId,
        $kind: kind,
        $since: since,
        $limit: limit,
      }) as any[];
      return rows.map(toGroupEventRecord).reverse();
    },

    pruneGroupEventsOlderThan(timestamp: number): number {
      const result = stmts.pruneGroupEvents.run({ $before: timestamp });
      return Number(result.changes || 0);
    },

    pruneMessagesOlderThan(timestamp: number): number {
      const result = stmts.pruneMessages.run({ $before: timestamp });
      return Number(result.changes || 0);
    },

    pruneTopicsOlderThan(timestamp: number): number {
      const result = stmts.pruneTopics.run({ $before: timestamp });
      return Number(result.changes || 0);
    },

    pruneMediaSummariesOlderThan(timestamp: number): number {
      const summaries = stmts.pruneMediaSummaries.run({ $before: timestamp });
      const sources = stmts.pruneMediaSummarySources.run({ $before: timestamp });
      return Number(summaries.changes || 0) + Number(sources.changes || 0);
    },

    pruneImagesOlderThan(timestamp: number): number {
      const result = stmts.pruneImages.run({ $before: timestamp });
      return Number(result.changes || 0);
    },

    saveImage(image: ImageRecord): void {
      stmts.insertImage.run({
        $hash: image.hash,
        $url: image.url,
        $type: image.type,
        $description: image.description,
        $emotion: null,
        $character: null,
        $filePath: null,
        $createdAt: image.createdAt,
      });
    },

    getImageByHash(hash: string): ImageRecord | null {
      const row = stmts.getImageByHash.get({ $hash: hash }) as any;
      if (!row) return null;
      return {
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        createdAt: row.created_at,
      };
    },

    getImageByUrl(url: string): ImageRecord | null {
      const row = stmts.getImageByUrl.get({ $url: url }) as any;
      if (!row) return null;
      return {
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        createdAt: row.created_at,
      };
    },

    getAllImages(): ImageRecord[] {
      const rows = stmts.getAllImages.all({}) as any[];
      return rows.map((row) => ({
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        createdAt: row.created_at,
      }));
    },

    saveMediaSummary(summary: MediaSummaryRecord): void {
      stmts.upsertMediaSummary.run({
        $key: summary.key,
        $kind: summary.kind,
        $source: summary.source,
        $summary: summary.summary,
        $createdAt: summary.createdAt,
      });
    },

    getMediaSummary(key: string): MediaSummaryRecord | null {
      const row = stmts.getMediaSummary.get({ $key: key }) as any;
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        kind: row.kind,
        source: row.source,
        summary: row.summary,
        createdAt: row.created_at,
      };
    },

    saveMediaSummarySource(sourceKey: string, summaryKey: string): void {
      stmts.upsertMediaSummarySource.run({
        $sourceKey: sourceKey,
        $summaryKey: summaryKey,
        $createdAt: Date.now(),
      });
    },

    getMediaSummaryBySource(sourceKey: string): MediaSummaryRecord | null {
      const row = stmts.getMediaSummaryBySource.get({ $sourceKey: sourceKey }) as any;
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        kind: row.kind,
        source: row.source,
        summary: row.summary,
        createdAt: row.created_at,
      };
    },

    close(): void {
      db.close();
    },
  };
}
