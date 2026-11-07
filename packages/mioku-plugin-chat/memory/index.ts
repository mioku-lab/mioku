import type { AIInstance, Logger } from "mioku";
import * as path from "node:path";
import type { ChatDatabase } from "../db";
import type { ChatConfig } from "../types";
import { InjectionCache, hashText } from "./cache";
import { MemoryExtractor } from "./extract";
import { Recall, formatProfile, formatRecallHits } from "./recall";
import { renderMemoryBlock } from "./render";
import { MemoryStore } from "./store";
import type { MemoryStatus } from "./types";
import { MemoryIndex } from "./vector";
import type { VectorServiceApi } from "mioku-service-vector";

export interface MemoryModel {
  instance: AIInstance;
  model: string;
}

export interface MemoryEngineDeps {
  db: ChatDatabase;
  dataDir: string;
  getConfig(groupId?: string): ChatConfig;
  /** 按角色取模型；工作模型缺失时调用方退回主模型 */
  getModel(role: "working" | "main"): MemoryModel | undefined;
  /** 向量服务；未安装时记忆退化为「轮廓 + 关键词」 */
  getVectors(): VectorServiceApi | undefined;
  logger: Logger;
}

export interface BuildMemoryContextInput {
  groupId?: string;
  sessionId: string;
  userId: string;
  userName: string;
  /** 本轮要回的消息正文，作为检索 query */
  query: string;
}

/** 暴露给其它插件的最小接口（agent 通过插件运行时状态取用） */
export interface ChatMemoryApi {
  listGroups(): Array<{ groupId: string; groupName?: string; items: number }>;
  recallContext(input: {
    group: string;
    query: string;
    days?: number;
    limit?: number;
  }): Promise<string>;
  memberProfile(input: { group: string; who: string }): Promise<string>;
  forget(input: { group: string; memoryId: number }): Promise<boolean>;
}

/**
 * 群聊记忆引擎。
 *
 * 写：群消息进缓冲，窗口攒够后由工作模型异步抽取记忆与群员轮廓；
 * 读：轮廓直读 + 混合检索，渲染成一段注入块，只塞进动态上下文；
 * 缓存：同一条消息引发的多轮对话复用同一块文本，写入即失效。
 */
export class MemoryEngine {
  private readonly store: MemoryStore;
  private readonly index: MemoryIndex;
  private readonly extractor: MemoryExtractor;
  private readonly recall: Recall;
  private readonly cache: InjectionCache;
  private pruneTimer: NodeJS.Timeout | null = null;
  private injected = 0;

  constructor(private readonly deps: MemoryEngineDeps) {
    this.store = new MemoryStore(path.join(deps.dataDir, "memory.db"));
    this.index = new MemoryIndex(deps.getVectors(), deps.logger);
    this.cache = new InjectionCache(deps.getConfig().memory.cacheTtlMs);
    this.extractor = new MemoryExtractor({
      store: this.store,
      index: this.index,
      getConfig: deps.getConfig,
      getModel: () => this.modelFor(),
      getMemberMessages: (groupId, userId, limit) =>
        deps.db
          .getMessagesByUser(userId, `group:${groupId}`, limit)
          .map((message) => ({
            content: message.content,
            timestamp: message.timestamp,
          }))
          // 数据库里是新→旧，提示词按时间正序更好读
          .reverse(),
      logger: deps.logger,
      onChanged: (groupId) => this.cache.invalidateGroup(groupId),
    });
    this.recall = new Recall({
      db: deps.db,
      store: this.store,
      index: this.index,
      getConfig: deps.getConfig,
      logger: deps.logger,
    });
  }

  async init(): Promise<void> {
    await this.index.ensure();
    this.extractor.start();
    this.pruneTimer = setInterval(
      () => this.prune(),
      60 * 60_000,
    );
    this.prune();
  }

  private modelFor(): MemoryModel | undefined {
    // 抽取用哪个角色由配置决定；工作模型缺失时调用方自己会退回主模型
    const role = this.deps.getConfig().memory.extractModel === "main" ? "main" : "working";
    return this.deps.getModel(role);
  }

  /** 群消息入库缓冲；原文入向量是可选档位（C） */
  observeMessage(input: {
    groupId: string;
    userId: string;
    userName: string;
    content: string;
    messageId?: string;
    timestamp: number;
  }): void {
    const cfg = this.deps.getConfig(input.groupId).memory;
    if (!cfg.enabled) return;
    this.extractor.observe(input);

    if (!cfg.indexMessages) return;
    const content = input.content.trim();
    if (content.length < Math.max(2, cfg.indexMessageMinChars)) return;
    void this.index.indexMessage({
      groupId: input.groupId,
      userId: input.userId,
      userName: input.userName,
      content,
      messageId: input.messageId,
      timestamp: input.timestamp,
    });
  }

  /**
   * 组装本轮的记忆注入块。任何异常或超时都返回空串——记忆不值得挡住回复。
   */
  async buildContext(input: BuildMemoryContextInput): Promise<string> {
    const { groupId, query } = input;
    if (!groupId || !query.trim()) return "";
    const cfg = this.deps.getConfig(groupId).memory;
    if (!cfg.enabled) return "";

    const key = `${groupId}|${input.userId}|${hashText(query)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const work = (async (): Promise<string> => {
      const speakerProfile = this.deps.getConfig(groupId).memory.profileEnabled
        ? this.store.getProfile(groupId, input.userId)
        : null;
      const hits = await this.index.searchItems(query, {
        groupId,
        topK: cfg.injectTopK,
        recencyHalfLifeMs: 14 * 24 * 60 * 60_000,
        minRelevance: cfg.minRelevance,
      });
      const items = [];
      for (const hit of hits) {
        const docId = String(hit.docId ?? "");
        const id = docId.startsWith("mem:") ? Number(docId.slice(4)) : 0;
        const item = id > 0 ? this.store.getItem(id) : null;
        if (item) items.push(item);
      }
      if (items.length === 0 && !speakerProfile) return "";
      return renderMemoryBlock(items, {
        maxChars: cfg.injectMaxChars,
        includeQuote: cfg.sourceTraceback,
        ...(speakerProfile ? { speakerProfile } : {}),
      });
    })();

    const block = await withTimeout(
      work,
      Math.max(50, cfg.injectTimeoutMs),
      () => {
        this.deps.logger.debug("[memory] 检索超时，本轮不注入记忆");
        return "";
      },
    );

    if (block) this.injected += 1;
    this.cache.set(key, groupId, block);
    return block;
  }

  /** 模型可调用的资料查找 */
  async recallGroupContext(input: {
    groupId: string;
    sessionId: string;
    query: string;
    days?: number;
    userId?: string;
    /** 用名字/id 限定某个成员 */
    who?: string;
    /** 只搜原子记忆，不混入画像/话题/原文（.记忆 搜索 用） */
    onlyMemories?: boolean;
    /** 先字面匹配，没有字面命中再走语义兜底（.记忆 搜索 用） */
    literalFirst?: boolean;
  }): Promise<string> {
    const cfg = this.deps.getConfig(input.groupId).memory;
    const userId = input.userId ?? (input.who
      ? (await this.recall.findProfile(input.groupId, input.who)).profile?.userId
      : undefined);
    const hits = await this.recall.search({
      query: input.query,
      groupId: input.groupId,
      sessionId: input.sessionId,
      days: Math.max(1, input.days ?? cfg.contextLookbackDays),
      limit: Math.max(3, cfg.injectTopK),
      ...(userId ? { userId } : {}),
      ...(input.onlyMemories ? { sources: ["memory"] } : {}),
      ...(input.literalFirst ? { literalFirst: true } : {}),
      minRelevance: cfg.minRelevance,
    });
    if (hits.length === 0) return "";

    const lines = [formatRecallHits(hits, 8)];
    // D 档：命中记忆时把原话一并给出来，模型不必猜
    const quotes: string[] = [];
    for (const hit of hits.filter((item) => item.source === "memory").slice(0, 2)) {
      if (!hit.memoryId) continue;
      quotes.push(...this.expandSources(hit.memoryId));
    }
    if (quotes.length > 0) {
      lines.push(`原文：\n${quotes.slice(0, 4).join("\n")}`);
    }
    return lines.join("\n\n");
  }

  async profileOfMember(input: { groupId: string; who: string }): Promise<string> {
    const { profile, memories } = await this.recall.findProfile(
      input.groupId,
      input.who,
    );
    if (!profile) return "";
    return formatProfile(profile, memories);
  }

  /** 命中记忆的原话回查，供 recall 工具补充细节 */
  expandSources(memoryId: number): string[] {
    const item = this.store.getItem(memoryId);
    if (!item) return [];
    const cfg = this.deps.getConfig(item.groupId).memory;
    return this.recall
      .expandSources(item, cfg.sourceTracebackLimit)
      .map((message) => `[${message.speaker} #${message.messageId}] ${message.text}`);
  }

  status(): MemoryStatus {
    return this.recall.status({
      enabled: this.deps.getConfig().memory.enabled,
      vectorReady: this.index.ready,
      buffered: this.extractor.buffered,
      bufferGroups: this.extractor.bufferGroups,
      injected: this.injected,
      cacheEntries: this.cache.size,
      lastExtractAt: this.extractor.lastRunAt(),
      lastError: this.extractor.error(),
    });
  }

  /** 强制抽取某个群（也用于验证抽取流水线） */
  async flush(groupId: string): Promise<void> {
    await this.extractor.flushGroup(groupId);
  }

  async forgetItem(groupId: string, memoryId: number): Promise<boolean> {
    const item = this.store.getItem(memoryId);
    if (!item || item.groupId !== groupId) return false;
    this.store.removeItems([memoryId]);
    await this.index.removeItems([memoryId]);
    this.cache.invalidateGroup(groupId);
    return true;
  }

  async clearGroup(groupId: string): Promise<number> {
    const ids = this.store.clearGroup(groupId);
    await this.index.clearGroup(groupId);
    await this.index.dropGroupMessages(groupId);
    this.cache.invalidateGroup(groupId);
    return ids.length;
  }

  async reindex(): Promise<string> {
    return this.index.reindex();
  }

  private prune(): void {
    try {
      const cfg = this.deps.getConfig().memory;
      const now = Date.now();
      const itemCutoff =
        now - Math.max(1, cfg.retentionMonths) * 30 * 24 * 60 * 60_000;
      const removedIds = this.store.deleteItemsOlderThan(itemCutoff);
      if (removedIds.length > 0) {
        void this.index.removeItems(removedIds);
        this.deps.logger.info(
          `[memory] 清理过期记忆 ${removedIds.length} 条（保留 ${cfg.retentionMonths} 个月）`,
        );
      }
      const profiles = this.store.deleteProfilesUpdatedBefore(itemCutoff);
      if (profiles > 0) {
        this.deps.logger.info(`[memory] 清理过期群员轮廓 ${profiles} 个`);
      }
      this.store.pruneWindowsBefore(itemCutoff);
      if (cfg.indexMessages) {
        const messageCutoff =
          now - Math.max(1, cfg.indexMessageRetentionDays) * 24 * 60 * 60_000;
        const groups = this.deps.db.listGroups(200).map((group) => group.groupId);
        void this.index.pruneMessages(groups, messageCutoff);
      }
    } catch (error) {
      this.deps.logger.warn(`[memory] 定期清理失败：${error}`);
    }
  }

  // ---- ChatMemoryApi：给 agent 之类的插件用 ----

  /** 供其它插件取用的稳定接口（不要直接用 MemoryEngine 内部方法） */
  readonly api: ChatMemoryApi = {
    listGroups: () => this.listGroups(),
    recallContext: (input) => this.apiRecallContext(input),
    memberProfile: (input) => this.apiMemberProfile(input),
    forget: (input) => this.apiForget(input),
  };

  listGroups(): Array<{ groupId: string; groupName?: string; items: number }> {
    return this.deps.db.listGroups(50).map((group) => ({
      groupId: group.groupId,
      ...(group.groupName ? { groupName: group.groupName } : {}),
      items: this.store.countItems(group.groupId),
    }));
  }

  async apiRecallContext(input: {
    group: string;
    query: string;
    days?: number;
    limit?: number;
  }): Promise<string> {
    const groupId = this.resolveGroup(input.group);
    if (!groupId) return "";
    return this.recallGroupContext({
      groupId,
      sessionId: `group:${groupId}`,
      query: input.query,
      ...(input.days ? { days: input.days } : {}),
    });
  }

  async apiMemberProfile(input: { group: string; who: string }): Promise<string> {
    const groupId = this.resolveGroup(input.group);
    if (!groupId) return "";
    return this.profileOfMember({ groupId, who: input.who });
  }

  async apiForget(input: { group: string; memoryId: number }): Promise<boolean> {
    const groupId = this.resolveGroup(input.group);
    if (!groupId) return false;
    return this.forgetItem(groupId, input.memoryId);
  }

  /** 允许用群号或群名指定 */
  private resolveGroup(input: string): string | undefined {
    const value = input.trim();
    if (!value) return undefined;
    const groups = this.deps.db.listGroups(200);
    const exact = groups.find((group) => group.groupId === value);
    if (exact) return exact.groupId;
    const byName = groups.find(
      (group) => group.groupName && group.groupName.includes(value),
    );
    return byName?.groupId;
  }

  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.extractor.stop();
    this.cache.clear();
    this.store.close();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}
