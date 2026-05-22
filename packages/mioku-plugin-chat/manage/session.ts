import type { SessionMeta, SessionType } from "../types";
import type { ChatDatabase } from "../db";

/**
 * LRU 会话管理器
 */
export class SessionManager {
  private cache: Map<string, SessionMeta> = new Map();
  private readonly maxSize: number;
  private db: ChatDatabase;

  constructor(db: ChatDatabase, maxSize: number) {
    this.db = db;
    this.maxSize = maxSize;
  }

  /**
   * 获取或创建会话
   */
  getOrCreate(id: string, type: SessionType, targetId: number): SessionMeta {
    // 先查缓存
    if (this.cache.has(id)) {
      return this.touch(id);
    }

    // 查数据库
    const existing = this.db.getSession(id);
    if (existing) {
      this.addToCache(id, existing);
      return existing;
    }

    // 创建新会话
    const now = Date.now();
    const session: SessionMeta = {
      id,
      type,
      targetId,
      createdAt: now,
      updatedAt: now,
      compressedContext: null,
    };
    this.db.saveSession(session);
    this.addToCache(id, session);
    return session;
  }

  /**
   * 获取会话（不创建）
   */
  get(id: string): SessionMeta | null {
    if (this.cache.has(id)) {
      return this.touch(id);
    }
    const existing = this.db.getSession(id);
    if (existing) {
      this.addToCache(id, existing);
      return existing;
    }
    return null;
  }

  /**
   * 更新访问时间并移至最近
   */
  touch(id: string): SessionMeta {
    const session = this.cache.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found in cache`);
    }
    // 删除再插入，移到 Map 末尾（最近使用）
    this.cache.delete(id);
    session.updatedAt = Date.now();
    this.cache.set(id, session);
    this.db.saveSession(session);
    return session;
  }

  /**
   * 重置 bot 消息
   */
  resetBotMessages(id: string): void {
    this.db.deleteBotMessages(id);
  }

  private addToCache(id: string, session: SessionMeta): void {
    // LRU 淘汰
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(id, session);
  }
}
