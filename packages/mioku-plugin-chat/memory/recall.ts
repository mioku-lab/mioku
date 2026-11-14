import type { Logger } from "mioku";
import type { ChatDatabase } from "../db";
import type { MemoryStore } from "./store";
import type { MemberProfile, MemoryItem, MemoryStatus } from "./types";
import { formatDateTime } from "./render";
import type { MemoryIndex } from "./vector";

const EDGE_PREFIX =
  /^(那个|这个|我们|你们|他们|请问|帮我|帮忙|告诉我|查一下|查查|找一下|搜一下|看看|一下|最近|之前|然后|还有|就是|关于|上次|上周|前天|昨天)/;
const EDGE_SUFFIX = /(吗|呢|吧|啊|呀|么|的|了|过|没有|没|是|在)$/u;

/** 语义兜底的最低余弦：低于它宁可说没查到，也不拿近似邻居凑数 */
const SEMANTIC_MIN_SCORE = 0.45;

/** 从自然语言查询里抠出可以直接喂给 LIKE 的词 */
export function extractKeywords(query: string, max = 5): string[] {
  const text = query.trim();
  if (!text) return [];
  const runs = text
    .split(/[^\p{L}\p{N}]+/u)
    .map((run) => run.trim())
    .filter(Boolean);
  const keywords: string[] = [];
  const push = (value: string) => {
    const cleaned = value.replace(EDGE_PREFIX, "").replace(EDGE_SUFFIX, "").trim();
    if (cleaned.length >= 2 && cleaned !== text) keywords.push(cleaned);
  };
  for (const run of runs) push(run);
  // 长句整体也算一个候选：用户经常直接贴一句原话
  if (text.length <= 16) push(text);
  return Array.from(new Set(keywords)).slice(0, max);
}

export interface RecallOptions {
  query: string;
  groupId: string;
  sessionId: string;
  /** 回溯天数 */
  days: number;
  /** 每路取多少条 */
  limit: number;
  userId?: string;
  /** 限定检索通道；缺省四路全开 */
  sources?: RecallHit["source"][];
  /** 先字面匹配，没有字面命中再走语义兜底 */
  literalFirst?: boolean;
  /** 语义命中最低余弦；字面命中不受此限 */
  minRelevance?: number;
}

export interface RecallHit {
  source: "memory" | "topic" | "message" | "profile";
  time: number;
  speaker: string;
  text: string;
  messageId?: string;
  /** 记忆条目 id，便于「忘掉」 */
  memoryId?: number;
  score: number;
}

export interface RecallDeps {
  db: ChatDatabase;
  store: MemoryStore;
  index: MemoryIndex;
  getConfig(groupId?: string): { memory: { contextLookbackDays: number; sourceTraceback: boolean; sourceTracebackLimit: number } };
  logger: Logger;
}

function scoreByKeywords(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  let matched = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword.toLowerCase())) matched += 1;
  }
  return matched / keywords.length;
}

/**
 * 资料查找：记忆（语义）→ 话题摘要（字面）→ 原文（LIKE）三路合并。
 * 三路各自排序后按「更相关、更近」混合，去重后交给模型。
 */
export class Recall {
  constructor(private readonly deps: RecallDeps) {}

  async search(options: RecallOptions): Promise<RecallHit[]> {
    const { query, groupId, sessionId, days, limit } = options;
    const since = Date.now() - Math.max(1, days) * 24 * 60 * 60_000;
    const keywords = extractKeywords(query);
    const hits: RecallHit[] = [];
    const sources = new Set(
      options.sources ?? ["memory", "profile", "topic", "message"],
    );

    const [memories, profileHits] = await Promise.all([
      sources.has("memory")
        ? (async () => {
            const base = {
              groupId,
              ...(options.userId ? { userId: options.userId } : {}),
              topK: Math.max(limit, 4),
              recencyHalfLifeMs: 14 * 24 * 60 * 60_000,
              since,
            };
            if (!options.literalFirst) {
              return this.deps.index.searchItems(query, {
                ...base,
                ...(options.minRelevance != null
                  ? { minRelevance: options.minRelevance }
                  : {}),
              });
            }
            // 先字面匹配；没有字面命中才退语义，且必须过相关度下限
            const literal = await this.deps.index.searchItems(query, {
              ...base,
              mode: "sparse",
            });
            if (literal.length > 0) return literal;
            return this.deps.index.searchItems(query, {
              ...base,
              mode: "dense",
              minRelevance: options.minRelevance ?? SEMANTIC_MIN_SCORE,
            });
          })()
        : Promise.resolve([]),
      sources.has("profile")
        ? this.deps.index.searchProfiles(query, groupId, 3)
        : Promise.resolve([]),
    ]);

    for (const hit of memories) {
      const docId = String(hit.docId ?? "");
      const memoryId = docId.startsWith("mem:") ? Number(docId.slice(4)) : 0;
      // 向量库里的文本带「发言人｜」前缀，展示时用条目正文，避免「嘟嘟：嘟嘟｜…」
      const item = memoryId > 0 ? this.deps.store.getItem(memoryId) : null;
      hits.push({
        source: "memory",
        time: item?.updatedAt ?? Number(hit.metadata.ts ?? 0),
        speaker: item?.userName ?? String(hit.metadata.userName || hit.metadata.userId || "群"),
        text: item
          ? `${item.content}${item.detail ? `；${item.detail}` : ""}`
          : hit.content,
        memoryId: memoryId || undefined,
        // 融合分在候选很少时会被归一化成 1，混排时用原始余弦相似度更公平
        score: Number(hit.denseScore ?? hit.score ?? 0),
      });
    }

    for (const hit of profileHits) {
      hits.push({
        source: "profile",
        time: Number(hit.metadata.ts ?? 0),
        speaker: String(hit.metadata.userName || hit.metadata.userId || ""),
        text: hit.content,
        score: Number(hit.score ?? 0),
      });
    }

    // 话题摘要：窗口级背景，字面重合就算命中
    const topics = sources.has("topic")
      ? this.deps.db.getTopics(sessionId, 40)
      : [];
    for (const topic of topics) {
      const haystack = `${topic.title}\n${topic.summary}\n${topic.keywords}`;
      const score = scoreByKeywords(haystack, keywords);
      if (score <= 0) continue;
      const time = topic.windowEndAt ?? topic.updatedAt;
      if (time < since) continue;
      hits.push({
        source: "topic",
        time,
        speaker: "话题",
        text: topic.summary,
        score: score * 0.8,
      });
    }

    if (sources.has("message") && keywords.length > 0) {
      const messages = this.deps.db.searchMessages(groupId, keywords, since, 200);
      for (const message of messages) {
        const score = scoreByKeywords(message.content, keywords);
        if (score <= 0) continue;
        hits.push({
          source: "message",
          time: message.timestamp,
          speaker: message.userName || message.userId || "?",
          text: message.content,
          messageId: message.messageId,
          score: score * 0.9,
        });
      }
    }

    return dedupe(hits)
      .sort((a, b) => b.score - a.score || b.time - a.time)
      .slice(0, limit * 3);
  }

  /** 轮廓：先按 id/名字直查，查不到再走向量 */
  async findProfile(
    groupId: string,
    who: string,
  ): Promise<{ profile: MemberProfile | null; memories: MemoryItem[] }> {
    const value = who.trim();
    if (!value) return { profile: null, memories: [] };

    const direct = this.deps.store.getProfile(groupId, value);
    if (direct) {
      return {
        profile: direct,
        memories: this.deps.store.listItems(groupId, {
          userId: value,
          limit: 6,
        }),
      };
    }

    const profiles = this.deps.store.listProfiles(groupId, 300);
    const byName = profiles.find(
      (profile) =>
        profile.name === value ||
        profile.aliases.includes(value) ||
        profile.name.includes(value) ||
        value.includes(profile.name),
    );
    if (byName) {
      return {
        profile: byName,
        memories: this.deps.store.listItems(groupId, {
          userId: byName.userId,
          limit: 6,
        }),
      };
    }

    const [hit] = await this.deps.index.searchProfiles(value, groupId, 1);
    const userId = hit ? String(hit.metadata.userId ?? "") : "";
    if (userId) {
      const profile = this.deps.store.getProfile(groupId, userId);
      if (profile) {
        return {
          profile,
          memories: this.deps.store.listItems(groupId, { userId, limit: 6 }),
        };
      }
    }
    return { profile: null, memories: [] };
  }

  /** 命中记忆后回查原文（D 档：可追溯） */
  expandSources(
    memory: MemoryItem,
    limit: number,
  ): Array<{ time: number; speaker: string; text: string; messageId: string }> {
    if (!this.deps.getConfig(memory.groupId).memory.sourceTraceback) return [];
    const out: Array<{
      time: number;
      speaker: string;
      text: string;
      messageId: string;
    }> = [];
    for (const messageId of memory.sourceMessageIds.slice(0, Math.max(1, limit))) {
      const message = this.deps.db.getMessageByMessageId(messageId);
      if (!message) continue;
      out.push({
        time: message.timestamp,
        speaker: message.userName || message.userId || "?",
        text: message.content,
        messageId,
      });
    }
    return out;
  }

  status(extra: {
    enabled: boolean;
    vectorReady: boolean;
    buffered: number;
    bufferGroups: number;
    injected: number;
    cacheEntries: number;
    lastExtractAt: number;
    lastError: string;
  }): MemoryStatus {
    return {
      ...this.deps.store.stats(),
      ...extra,
    };
  }
}

function dedupe(hits: RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const hit of hits) {
    const key = hit.messageId
      ? `m:${hit.messageId}`
      : hit.memoryId
        ? `mem:${hit.memoryId}`
        : `${hit.source}:${hit.text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** 给工具输出用的紧凑格式 */
export function formatRecallHits(hits: RecallHit[], max = 8): string {
  return hits
    .slice(0, max)
    .map((hit) => {
      const when = hit.time > 0 ? formatDateTime(hit.time) : "";
      const tag =
        hit.source === "memory"
          ? "记忆"
          : hit.source === "topic"
            ? "话题"
            : hit.source === "profile"
              ? "画像"
              : "原文";
      const id = hit.messageId ? ` #${hit.messageId}` : "";
      return `[${when}]（${tag}）${hit.speaker}${id}：${hit.text}`;
    })
    .join("\n");
}

export function formatProfile(
  profile: MemberProfile,
  memories: MemoryItem[],
): string {
  const lines = [
    `成员：${profile.name || profile.userId}（${profile.userId}）`,
  ];
  const push = (label: string, values: string[]) => {
    if (values.length === 0) return;
    lines.push(`${label}：${values.join("、")}`);
  };
  push("别名", profile.aliases);
  push("特征", profile.traits);
  push("习惯", profile.habits);
  push("常聊话题", profile.topics);
  push("关系", profile.relations);
  if (profile.note) lines.push(`印象：${profile.note}`);
  if (memories.length > 0) {
    lines.push("相关记忆：");
    for (const memory of memories) {
      lines.push(`- ${formatDateTime(memory.updatedAt)} ${memory.content}`);
    }
  }
  return lines.join("\n");
}
