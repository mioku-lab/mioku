import Database from "better-sqlite3";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import type {
  SessionMeta,
  ChatMessage,
  TopicRecord,
  ExpressionRecord,
  ImageRecord,
  MediaSummaryRecord,
} from "./types";

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
  getBotMessages(groupId: number, limit?: number): ChatMessage[];
  getStoredGroupNoticeMessages(groupId: number, limit?: number): ChatMessage[];
  getMessagesByUser(
    userId: number,
    sessionId?: string,
    limit?: number,
  ): ChatMessage[];
  getAllMessagesByUser(userId: number, sessionId?: string): ChatMessage[];
  getMessagesByTimeRange(
    sessionId: string,
    startTimestamp: number,
    endTimestamp: number,
  ): ChatMessage[];
  searchMessages(
    sessionId: string,
    keyword: string,
    limit?: number,
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
  // 表达学习
  saveExpression(expr: ExpressionRecord): void;
  getExpressions(sessionId: string, limit?: number): ExpressionRecord[];
  getExpressionsByUser(userId: number, limit?: number): ExpressionRecord[];
  replaceExpressionsByUser(
    userId: number,
    userName: string,
    expressions: Array<
      Pick<ExpressionRecord, "situation" | "style" | "example">
    >,
  ): void;
  getExpressionCount(sessionId: string): number;
  deleteOldestExpressions(sessionId: string, keepCount: number): void;
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
  db.pragma("journal_mode = WAL");

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
      message_id INTEGER
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

    CREATE TABLE IF NOT EXISTS expressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      situation TEXT NOT NULL,
      style TEXT NOT NULL,
      example TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expressions_session ON expressions(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_expressions_user ON expressions(user_id, created_at);

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

  // 预编译语句
  const stmts = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, type, target_id, created_at, updated_at, compressed_context)
      VALUES (@id, @type, @targetId, @createdAt, @updatedAt, @compressedContext)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = @updatedAt,
        compressed_context = COALESCE(@compressedContext, compressed_context)
    `),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
    insertMessage: db.prepare(`
      INSERT INTO messages (session_id, role, content, user_id, user_name, user_role, user_title, group_id, group_name, timestamp, message_id)
      VALUES (@sessionId, @role, @content, @userId, @userName, @userRole, @userTitle, @groupId, @groupName, @timestamp, @messageId)
    `),
    getMessages: db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?
    `),
    getMessagesBefore: db.prepare(`
      SELECT * FROM messages WHERE session_id = ? AND timestamp < ? ORDER BY timestamp DESC, id DESC LIMIT ?
    `),
    getBotMessages: db.prepare(`
      SELECT * FROM messages WHERE group_id = ? AND role = 'assistant' ORDER BY timestamp DESC LIMIT ?
    `),
    getStoredGroupNoticeMessages: db.prepare(`
      SELECT * FROM messages
      WHERE group_id = ? AND role = 'user' AND content LIKE '发布了一条群公告：%'
      ORDER BY timestamp DESC LIMIT ?
    `),
    getMessagesByUser: db.prepare(`
      SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
    `),
    getAllMessagesByUser: db.prepare(`
      SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp DESC, id DESC
    `),
    getMessagesByUserInSession: db.prepare(`
      SELECT * FROM messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT ?
    `),
    getAllMessagesByUserInSession: db.prepare(`
      SELECT * FROM messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp DESC, id DESC
    `),
    getMessagesByTimeRange: db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC, id ASC
    `),
    updateCompressedContext: db.prepare(`
      UPDATE sessions SET compressed_context = ?, updated_at = ? WHERE id = ?
    `),
    deleteSessionMessages: db.prepare(`
      DELETE FROM messages WHERE session_id = ?
    `),
    deleteBotMessages: db.prepare(`
      DELETE FROM messages WHERE session_id = ? AND role = 'assistant'
    `),
    resetSessionContext: db.prepare(`
      UPDATE sessions SET compressed_context = NULL, updated_at = ? WHERE id = ?
    `),
    // 消息搜索
    searchMessages: db.prepare(`
      SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?
    `),
    // 话题
    insertTopic: db.prepare(`
      INSERT INTO topics (session_id, title, keywords, summary, message_count, window_start_at, window_end_at, created_at, updated_at)
      VALUES (@sessionId, @title, @keywords, @summary, @messageCount, @windowStartAt, @windowEndAt, @createdAt, @updatedAt)
    `),
    getTopics: db.prepare(`
      SELECT * FROM topics WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?
    `),
    getTopicByWindow: db.prepare(`
      SELECT * FROM topics
      WHERE session_id = ? AND window_start_at = ? AND window_end_at = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    updateTopic: db.prepare(`
      UPDATE topics SET summary = @summary, keywords = @keywords, message_count = @messageCount, updated_at = @updatedAt WHERE id = @id
    `),
    // 表达学习
    insertExpression: db.prepare(`
      INSERT INTO expressions (session_id, user_id, user_name, situation, style, example, created_at)
      VALUES (@sessionId, @userId, @userName, @situation, @style, @example, @createdAt)
    `),
    getExpressions: db.prepare(`
      SELECT * FROM expressions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
    `),
    getExpressionsByUser: db.prepare(`
      SELECT * FROM expressions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `),
    getExpressionCount: db.prepare(`
      SELECT COUNT(*) as count FROM expressions WHERE session_id = ?
    `),
    deleteExpressionsByUser: db.prepare(`
      DELETE FROM expressions WHERE user_id = ?
    `),
    deleteOldestExpressions: db.prepare(`
      DELETE FROM expressions WHERE session_id = ? AND id NOT IN (
        SELECT id FROM expressions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
      )
    `),
    // 图片记录
    insertImage: db.prepare(`
      INSERT OR IGNORE INTO images (hash, url, type, description, emotion, character, file_path, created_at)
      VALUES (@hash, @url, @type, @description, @emotion, @character, @filePath, @createdAt)
    `),
    getImageByHash: db.prepare(`SELECT * FROM images WHERE hash = ?`),
    getImageByUrl: db.prepare(`SELECT * FROM images WHERE url = ?`),
    getAllImages: db.prepare(`SELECT * FROM images ORDER BY created_at DESC`),
    upsertMediaSummary: db.prepare(`
      INSERT INTO media_summaries (key, kind, source, summary, created_at)
      VALUES (@key, @kind, @source, @summary, @createdAt)
      ON CONFLICT(key) DO UPDATE SET
        summary = @summary,
        source = @source,
        created_at = @createdAt
    `),
    getMediaSummary: db.prepare(`SELECT * FROM media_summaries WHERE key = ?`),
    upsertMediaSummarySource: db.prepare(`
      INSERT INTO media_summary_sources (source_key, summary_key, created_at)
      VALUES (@sourceKey, @summaryKey, @createdAt)
      ON CONFLICT(source_key) DO UPDATE SET
        summary_key = @summaryKey,
        created_at = @createdAt
    `),
    getMediaSummaryBySource: db.prepare(`
      SELECT s.*
      FROM media_summary_sources src
      JOIN media_summaries s ON s.key = src.summary_key
      WHERE src.source_key = ?
    `),
  };

  return {
    saveSession(meta: SessionMeta): void {
      stmts.upsertSession.run({
        id: meta.id,
        type: meta.type,
        targetId: meta.targetId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        compressedContext: meta.compressedContext,
      });
    },

    getSession(id: string): SessionMeta | null {
      const row = stmts.getSession.get(id) as any;
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
        sessionId: msg.sessionId,
        role: msg.role,
        content: msg.content,
        userId: msg.userId ?? null,
        userName: msg.userName ?? null,
        userRole: msg.userRole ?? null,
        userTitle: msg.userTitle ?? null,
        groupId: msg.groupId ?? null,
        groupName: msg.groupName ?? null,
        timestamp: msg.timestamp,
        messageId: msg.messageId ?? null,
      });
    },

    getMessages(
      sessionId: string,
      limit: number = 30,
      before?: number,
    ): ChatMessage[] {
      const rows = before
        ? (stmts.getMessagesBefore.all(sessionId, before, limit) as any[])
        : (stmts.getMessages.all(sessionId, limit) as any[]);

      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse(); // 按时间正序
    },

    getBotMessages(groupId: number, limit: number = 50): ChatMessage[] {
      const rows = stmts.getBotMessages.all(groupId, limit) as any[];
      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse(); // 按时间正序
    },

    getStoredGroupNoticeMessages(
      groupId: number,
      limit: number = 20,
    ): ChatMessage[] {
      const rows = stmts.getStoredGroupNoticeMessages.all(
        groupId,
        limit,
      ) as any[];
      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse();
    },

    getMessagesByUser(
      userId: number,
      sessionId?: string,
      limit: number = 20,
    ): ChatMessage[] {
      const rows = sessionId
        ? (stmts.getMessagesByUserInSession.all(
            userId,
            sessionId,
            limit,
          ) as any[])
        : (stmts.getMessagesByUser.all(userId, limit) as any[]);

      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse();
    },

    getAllMessagesByUser(userId: number, sessionId?: string): ChatMessage[] {
      const rows = sessionId
        ? (stmts.getAllMessagesByUserInSession.all(userId, sessionId) as any[])
        : (stmts.getAllMessagesByUser.all(userId) as any[]);

      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse();
    },

    getMessagesByTimeRange(
      sessionId: string,
      startTimestamp: number,
      endTimestamp: number,
    ): ChatMessage[] {
      const rows = stmts.getMessagesByTimeRange.all(
        sessionId,
        startTimestamp,
        endTimestamp,
      ) as any[];
      return rows.map((row) => ({
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
        messageId: row.message_id,
      }));
    },

    updateCompressedContext(sessionId: string, context: string): void {
      stmts.updateCompressedContext.run(context, Date.now(), sessionId);
    },

    deleteSessionMessages(sessionId: string): void {
      stmts.deleteSessionMessages.run(sessionId);
      stmts.resetSessionContext.run(Date.now(), sessionId);
    },

    deleteBotMessages(sessionId: string): void {
      stmts.deleteBotMessages.run(sessionId);
    },

    searchMessages(
      sessionId: string,
      keyword: string,
      limit: number = 20,
    ): ChatMessage[] {
      const rows = stmts.searchMessages.all(
        sessionId,
        `%${keyword}%`,
        limit,
      ) as any[];
      return rows
        .map((row) => ({
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
          messageId: row.message_id,
        }))
        .reverse();
    },

    saveTopic(topic: TopicRecord): number {
      const result = stmts.insertTopic.run({
        sessionId: topic.sessionId,
        title: topic.title,
        keywords: topic.keywords,
        summary: topic.summary,
        messageCount: topic.messageCount,
        windowStartAt: topic.windowStartAt ?? null,
        windowEndAt: topic.windowEndAt ?? null,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      });
      return Number(result.lastInsertRowid);
    },

    getTopics(sessionId: string, limit: number = 10): TopicRecord[] {
      const rows = stmts.getTopics.all(sessionId, limit) as any[];
      return rows.map((row) => ({
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
      }));
    },

    getTopicByWindow(
      sessionId: string,
      windowStartAt: number,
      windowEndAt: number,
    ): TopicRecord | null {
      const row = stmts.getTopicByWindow.get(
        sessionId,
        windowStartAt,
        windowEndAt,
      ) as any;
      if (!row) return null;
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
    },

    updateTopic(
      id: number,
      updates: Partial<
        Pick<TopicRecord, "summary" | "keywords" | "messageCount" | "updatedAt">
      >,
    ): void {
      // 先获取当前值用于合并
      const current = db
        .prepare("SELECT * FROM topics WHERE id = ?")
        .get(id) as any;
      if (!current) return;
      stmts.updateTopic.run({
        id,
        summary: updates.summary ?? current.summary,
        keywords: updates.keywords ?? current.keywords,
        messageCount: updates.messageCount ?? current.message_count,
        updatedAt: updates.updatedAt ?? Date.now(),
      });
    },

    saveExpression(expr: ExpressionRecord): void {
      stmts.insertExpression.run({
        sessionId: expr.sessionId,
        userId: expr.userId,
        userName: expr.userName,
        situation: expr.situation,
        style: expr.style,
        example: expr.example,
        createdAt: expr.createdAt,
      });
    },

    getExpressions(sessionId: string, limit: number = 50): ExpressionRecord[] {
      const rows = stmts.getExpressions.all(sessionId, limit) as any[];
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        userId: row.user_id,
        userName: row.user_name,
        situation: row.situation,
        style: row.style,
        example: row.example,
        createdAt: row.created_at,
      }));
    },

    getExpressionsByUser(
      userId: number,
      limit: number = 50,
    ): ExpressionRecord[] {
      const rows = stmts.getExpressionsByUser.all(userId, limit) as any[];
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        userId: row.user_id,
        userName: row.user_name,
        situation: row.situation,
        style: row.style,
        example: row.example,
        createdAt: row.created_at,
      }));
    },

    replaceExpressionsByUser(
      userId: number,
      userName: string,
      expressions: Array<
        Pick<ExpressionRecord, "situation" | "style" | "example">
      >,
    ): void {
      const now = Date.now();
      const tx = db.transaction(
        (
          targetUserId: number,
          targetUserName: string,
          rows: Array<
            Pick<ExpressionRecord, "situation" | "style" | "example">
          >,
        ) => {
          stmts.deleteExpressionsByUser.run(targetUserId);
          for (const row of rows) {
            stmts.insertExpression.run({
              sessionId: `user:${targetUserId}`,
              userId: targetUserId,
              userName: targetUserName,
              situation: row.situation,
              style: row.style,
              example: row.example,
              createdAt: now,
            });
          }
        },
      );

      tx(userId, userName, expressions);
    },

    getExpressionCount(sessionId: string): number {
      const row = stmts.getExpressionCount.get(sessionId) as any;
      return row?.count ?? 0;
    },

    deleteOldestExpressions(sessionId: string, keepCount: number): void {
      stmts.deleteOldestExpressions.run(sessionId, sessionId, keepCount);
    },

    saveImage(image: ImageRecord): void {
      stmts.insertImage.run({
        hash: image.hash,
        url: image.url,
        type: image.type,
        description: image.description,
        emotion: image.emotion ?? null,
        character: image.character ?? null,
        filePath: image.filePath ?? null,
        createdAt: image.createdAt,
      });
    },

    getImageByHash(hash: string): ImageRecord | null {
      const row = stmts.getImageByHash.get(hash) as any;
      if (!row) return null;
      return {
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        emotion: row.emotion,
        character: row.character,
        filePath: row.file_path,
        createdAt: row.created_at,
      };
    },

    getImageByUrl(url: string): ImageRecord | null {
      const row = stmts.getImageByUrl.get(url) as any;
      if (!row) return null;
      return {
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        emotion: row.emotion,
        character: row.character,
        filePath: row.file_path,
        createdAt: row.created_at,
      };
    },

    getAllImages(): ImageRecord[] {
      const rows = stmts.getAllImages.all() as any[];
      return rows.map((row) => ({
        id: row.id,
        hash: row.hash,
        url: row.url,
        type: row.type,
        description: row.description,
        emotion: row.emotion,
        character: row.character,
        filePath: row.file_path,
        createdAt: row.created_at,
      }));
    },

    saveMediaSummary(summary: MediaSummaryRecord): void {
      stmts.upsertMediaSummary.run({
        key: summary.key,
        kind: summary.kind,
        source: summary.source,
        summary: summary.summary,
        createdAt: summary.createdAt,
      });
    },

    getMediaSummary(key: string): MediaSummaryRecord | null {
      const row = stmts.getMediaSummary.get(key) as any;
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
        sourceKey,
        summaryKey,
        createdAt: Date.now(),
      });
    },

    getMediaSummaryBySource(sourceKey: string): MediaSummaryRecord | null {
      const row = stmts.getMediaSummaryBySource.get(sourceKey) as any;
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
