import type {
  SearchHit,
  SearchQuery,
  VectorServiceApi,
} from "mioku-service-vector";
import type { Logger } from "mioku";
import type { MemberProfile, MemoryItem } from "./types";

export const MEMORY_COLLECTION = "chat.memory";
export const PROFILE_COLLECTION = "chat.profile";
export const MESSAGE_COLLECTION_PREFIX = "chat.msg.";
/** 记忆检索里字面匹配权重要高一些：默认 0.9 稠密会把“猫娘”这类精确词挤出窗口 */
const MEMORY_DENSE_WEIGHT = 0.6;
/** 单群原文索引上限，超过按写入时间淘汰（稠密检索本来也只扫最新 2 万条） */
const MESSAGE_COLLECTION_MAX_RECORDS = 20000;

function messageCollection(groupId: string): string {
  return `${MESSAGE_COLLECTION_PREFIX}${groupId}`;
}

export function memoryDocId(id: number): string {
  return `mem:${id}`;
}

export function profileDocId(groupId: string, userId: string): string {
  return `profile:${groupId}:${userId}`;
}

export interface MemoryIndexLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface SearchMemoriesOptions {
  groupId: string;
  userId?: string;
  topK: number;
  /** 时间衰减半衰期；0 表示不衰减 */
  recencyHalfLifeMs?: number;
  since?: number;
  /** 检索通道：默认 hybrid；sparse 只做字面，dense 只做语义 */
  mode?: "hybrid" | "sparse" | "dense";
  /** 最低相关度（余弦）；字面命中不受此限，低于它的语义命中丢弃 */
  minRelevance?: number;
}

/** 向量索引层：只负责把记忆/轮廓/原文写进 collection 并检索，失败一律降级 */
export class MemoryIndex {
  constructor(
    private readonly vectors: VectorServiceApi | undefined,
    private readonly logger: MemoryIndexLogger,
  ) {}

  get ready(): boolean {
    return Boolean(this.vectors?.status().ready);
  }

  async ensure(): Promise<void> {
    if (!this.vectors) return;
    try {
      await this.vectors.ensureCollection(MEMORY_COLLECTION, {
        metadata: { app: "chat", kind: "memory" },
      });
      await this.vectors.ensureCollection(PROFILE_COLLECTION, {
        metadata: { app: "chat", kind: "profile" },
      });
    } catch (error) {
      this.logger.warn(`[memory] 初始化向量库失败：${error}`);
    }
  }

  private itemText(item: MemoryItem): string {
    const who = item.userId ? item.userName || item.userId : "群";
    const detail = item.detail ? `；${item.detail}` : "";
    return `${who}｜${item.content}${detail}`;
  }

  async syncItem(item: MemoryItem & { id: number }): Promise<void> {
    if (!this.vectors) return;
    try {
      await this.vectors.upsert({
        collection: MEMORY_COLLECTION,
        docId: memoryDocId(item.id),
        content: this.itemText(item),
        metadata: {
          groupId: item.groupId,
          userId: item.userId ?? "",
          userName: item.userName ?? "",
          kind: item.kind,
          importance: item.importance,
          ts: item.updatedAt,
        },
        createdAt: item.createdAt,
      });
    } catch (error) {
      this.logger.warn(`[memory] 写入记忆向量失败：${error}`);
    }
  }

  async removeItems(ids: number[]): Promise<void> {
    if (!this.vectors || ids.length === 0) return;
    try {
      this.vectors.remove(
        MEMORY_COLLECTION,
        ids.map((id) => memoryDocId(id)),
      );
    } catch (error) {
      this.logger.warn(`[memory] 删除记忆向量失败：${error}`);
    }
  }

  async syncProfile(profile: MemberProfile): Promise<void> {
    if (!this.vectors) return;
    const parts = [
      profile.name,
      ...profile.aliases,
      ...profile.traits,
      ...profile.habits,
      ...profile.topics,
      ...profile.relations,
      profile.note,
    ].filter(Boolean);
    if (parts.length === 0) return;
    try {
      await this.vectors.upsert({
        collection: PROFILE_COLLECTION,
        docId: profileDocId(profile.groupId, profile.userId),
        content: `${profile.name || profile.userId}（${profile.userId}）：${parts.join("，")}`,
        metadata: {
          groupId: profile.groupId,
          userId: profile.userId,
          userName: profile.name,
          ts: profile.updatedAt,
        },
        createdAt: profile.createdAt,
      });
    } catch (error) {
      this.logger.warn(`[memory] 写入轮廓向量失败：${error}`);
    }
  }

  async removeProfiles(groupId: string, userIds: string[]): Promise<void> {
    if (!this.vectors || userIds.length === 0) return;
    try {
      this.vectors.remove(
        PROFILE_COLLECTION,
        userIds.map((userId) => profileDocId(groupId, userId)),
      );
    } catch (error) {
      this.logger.warn(`[memory] 删除轮廓向量失败：${error}`);
    }
  }

  async searchItems(
    query: string,
    options: SearchMemoriesOptions,
  ): Promise<SearchHit[]> {
    if (!this.vectors || !query.trim()) return [];
    const topK = Math.max(1, options.topK);
    try {
      const request: SearchQuery = {
        collection: MEMORY_COLLECTION,
        query,
        denseWeight: MEMORY_DENSE_WEIGHT,
        // 多取一倍再按相关度过滤，避免真正相关的条目被低分邻居挤出窗口
        topK: options.minRelevance != null ? Math.min(topK * 2, 200) : topK,
        filter: {
          and: [
            { eq: { groupId: options.groupId } },
            ...(options.userId ? [{ eq: { userId: options.userId } }] : []),
            ...(options.since
              ? [{ range: { ts: { gte: options.since } } }]
              : []),
          ],
        },
        ...(options.recencyHalfLifeMs
          ? { recencyHalfLifeMs: options.recencyHalfLifeMs }
          : {}),
      };
      const hits =
        options.mode === "sparse"
          ? await this.vectors.searchSparse(request)
          : options.mode === "dense"
            ? await this.vectors.searchDense(request)
            : await this.vectors.search(request);
      if (options.minRelevance != null) {
        const min = options.minRelevance;
        return hits
          .filter(
            (hit) => (hit.sparseScore ?? 0) > 0 || (hit.denseScore ?? 0) >= min,
          )
          .slice(0, topK);
      }
      return hits;
    } catch (error) {
      this.logger.debug(`[memory] 检索记忆失败：${error}`);
      return [];
    }
  }

  async searchProfiles(
    query: string,
    groupId: string,
    topK: number,
  ): Promise<SearchHit[]> {
    if (!this.vectors || !query.trim()) return [];
    try {
      return await this.vectors.search({
        collection: PROFILE_COLLECTION,
        query,
        topK: Math.max(1, topK),
        filter: { eq: { groupId } },
      });
    } catch (error) {
      this.logger.debug(`[memory] 检索轮廓失败：${error}`);
      return [];
    }
  }

  /** 原文索引：可选功能，开启后每条有信息量的群消息都会入向量 */
  async indexMessage(input: {
    groupId: string;
    userId: string;
    userName: string;
    content: string;
    messageId?: string;
    timestamp: number;
  }): Promise<void> {
    if (!this.vectors) return;
    const collection = messageCollection(input.groupId);
    try {
      await this.vectors.ensureCollection(collection, {
        maxRecords: MESSAGE_COLLECTION_MAX_RECORDS,
        metadata: { app: "chat", kind: "message", groupId: input.groupId },
      });
      await this.vectors.upsert({
        collection,
        docId: `msg:${input.groupId}:${input.messageId || input.timestamp}`,
        content: `${input.userName}：${input.content}`,
        metadata: {
          groupId: input.groupId,
          userId: input.userId,
          userName: input.userName,
          messageId: input.messageId ?? "",
          ts: input.timestamp,
        },
        createdAt: input.timestamp,
      });
    } catch (error) {
      this.logger.debug(`[memory] 原文入向量失败：${error}`);
    }
  }

  async searchMessages(
    query: string,
    options: { groupId: string; topK: number; since?: number },
  ): Promise<SearchHit[]> {
    if (!this.vectors || !query.trim()) return [];
    try {
      return await this.vectors.search({
        collection: messageCollection(options.groupId),
        query,
        topK: Math.max(1, options.topK),
        ...(options.since
          ? { filter: { range: { ts: { gte: options.since } } } }
          : {}),
      });
    } catch (error) {
      this.logger.debug(`[memory] 检索原文失败：${error}`);
      return [];
    }
  }

  async pruneMessages(groupIds: string[], before: number): Promise<void> {
    if (!this.vectors) return;
    for (const groupId of groupIds) {
      try {
        this.vectors.removeWhere(messageCollection(groupId), {
          range: { ts: { lte: before } },
        });
      } catch (error) {
        this.logger.debug(`[memory] 清理原文索引失败：${error}`);
      }
    }
  }

  async dropGroupMessages(groupId: string): Promise<void> {
    if (!this.vectors) return;
    try {
      await this.vectors.dropCollection(messageCollection(groupId));
    } catch (error) {
      this.logger.debug(`[memory] 删除原文索引失败：${error}`);
    }
  }

  async clearGroup(groupId: string): Promise<void> {
    if (!this.vectors) return;
    try {
      this.vectors.removeWhere(MEMORY_COLLECTION, { eq: { groupId } });
      this.vectors.removeWhere(PROFILE_COLLECTION, { eq: { groupId } });
    } catch (error) {
      this.logger.warn(`[memory] 清空群记忆索引失败：${error}`);
    }
  }

  async reindex(): Promise<string> {
    if (!this.vectors) return "向量服务未启用";
    try {
      const memory = await this.vectors.reindex(MEMORY_COLLECTION);
      const profile = await this.vectors.reindex(PROFILE_COLLECTION);
      return `重建完成：记忆 ${memory.embedded}/${memory.total}，轮廓 ${profile.embedded}/${profile.total}`;
    } catch (error) {
      return `重建失败：${error}`;
    }
  }
}
