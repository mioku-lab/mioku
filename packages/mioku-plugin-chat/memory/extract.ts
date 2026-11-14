import type { AIInstance, Logger } from "mioku";
import type { ChatConfig } from "../types";
import { extractJsonObject } from "../utils/json";
import { isRecord, readField } from "../utils/record";
import { formatDateTime } from "./render";
import type { MemoryStore } from "./store";
import type {
  ExtractedMemory,
  MemberProfile,
  MemoryItem,
  MemoryKind,
} from "./types";
import type { MemoryIndex } from "./vector";
import { WORKING_MAX_TOKENS } from "../utils/model";

const KINDS = new Set<MemoryKind>([
  "fact",
  "event",
  "preference",
  "promise",
  "relation",
  "plan",
  "health",
  "other",
]);

interface BufferedMessage {
  userId: string;
  userName: string;
  content: string;
  messageId?: string;
  timestamp: number;
}

/** 模型输出不可用（空正文 / JSON 截断）：重试同一个窗口只会重复烧钱，直接作废 */
class UnusableOutputError extends Error {}

export interface ExtractModel {
  instance: AIInstance;
  model: string;
}

export interface ExtractorDeps {
  store: MemoryStore;
  index: MemoryIndex;
  getConfig(groupId?: string): ChatConfig;
  /** 抽取用的模型（工作模型优先），不可用时返回 undefined */
  getModel(): ExtractModel | undefined;
  /** 取某个成员最近的发言，画像需要这些才能看出说话习惯 */
  getMemberMessages?(
    groupId: string,
    userId: string,
    limit: number,
  ): Array<{ content: string; timestamp: number }>;
  logger: Logger;
  /** 有新记忆落库后通知上层失效注入缓存 */
  onChanged(groupId: string): void;
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const list = value.map((item) => cleanText(item, maxLength)).filter(Boolean);
  return Array.from(new Set(list)).slice(0, maxItems);
}

const EXTRACT_PROMPT_HEADER = `你在维护一个 QQ 群的长期记忆库。下面是群里最近的一段对话，请从中挑出**值得长期记住**的信息。

写作要求（很重要）：
1. content 必须是完整、具体、能独立看懂的陈述句：写清「谁、什么时候、发生了什么、涉及的关键数字/地点/物品/名字」。
   反面例子：「小明最近有事」「有人在聊工作」——太笼统，禁止。
   正面例子：「小明他妈上周住院，他这几天都在医院陪床，人很累，说明天有空再聊」。
2. 尽量详细：把来龙去脉、结果、对方当时的处境写进 content（1~3 句），必要时用 detail 补背景。
3. 如果记录里有关键原话，把最有信息量的一句**原样**抄进 quote（不要改写、不要加引号、保留语气）。
4. 只记以后聊天用得到的东西：身份与近况、重要事件、偏好与忌讳、约定与计划、人际关系、健康与情绪状态。
   不记：寒暄、复读、表情包、纯玩笑、一句就过的情绪、你无法确定真假的内容。
5. 不确定就不记，宁缺毋滥；一次最多 6 条。已有记忆里已经写过的不要重复出现。
6. about 填发言人 user_id（必须是下面记录里出现过的数字/字符串）；群级约定或群体事件填 "group"。
7. importance：3=日常有用，4=重要（健康/工作/关系变化），5=必须记住（承诺、重大事件）。
8. confidence：你有多确定这是真的（0~1）；转述、猜测、玩笑都要降低。

只输出 JSON，不要任何解释：
{"memories":[{"about":"123456","about_name":"小明","kind":"health|fact|event|preference|promise|relation|plan|other","content":"...","detail":"...","quote":"...","importance":4,"confidence":0.8,"message_ids":["..."]}]}`;

const PROFILE_PROMPT_HEADER = `你在维护 QQ 群里某个成员的长期画像，供机器人聊天时参考。下面是这个人最近的发言（可能很碎很随意）和关于他的记忆。

尽量从发言里看出东西，重点观察：
1. 说话风格：句子长短、爱不爱用表情/颜文字/重复字、语气词、标点习惯、口头禅。
2. 性格与态度：爱开玩笑还是较真、话多还是话少、常抱怨还是常捧场。
3. 常聊话题：反复出现的游戏、作品、人物、生活琐事。
4. 关系：常和谁互怼或互动，别人怎么称呼他。
5. 身份与近况：学生/打工人、所在城市、正在忙的事——只在有明确证据时写。

写法要求：
- traits / habits / topics / relations 每项都是一个短句（不超过 20 字），能直接放进提示词。
- habits 专写说话方式，例如「句尾爱加～」「爱用『草』表示无语」「一次发好几条短句」。
- 有证据就写，没证据就留空数组，不要猜、不要编。
- note 用 100 字以内概括这个人，写成「他/她……」。
- 名字用群里最常用的称呼。

只输出 JSON（所有字段都要有，没有就给空数组或空串）：
{"name":"","aliases":[],"traits":[],"habits":[],"topics":[],"relations":[],"note":""}`;

export class MemoryExtractor {
  private readonly buffers = new Map<string, BufferedMessage[]>();
  private readonly running = new Set<string>();
  /** 下次允许抽取的时间：失败后退避，避免反复烧模型 */
  private readonly nextAttemptAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastError = "";
  private lastExtractAt = 0;

  constructor(private readonly deps: ExtractorDeps) {}

  get bufferGroups(): number {
    return Array.from(this.buffers.values()).filter((list) => list.length > 0)
      .length;
  }

  get buffered(): number {
    let total = 0;
    for (const list of this.buffers.values()) total += list.length;
    return total;
  }

  start(): void {
    if (this.timer) return;
    const configured = Number(this.deps.getConfig().memory.extractIntervalMs);
    const interval = Number.isFinite(configured)
      ? Math.max(30_000, configured)
      : 5 * 60_000;
    this.timer = setInterval(() => {
      this.flushDue().catch((error) => {
        this.deps.logger.warn(`[memory] 定时抽取失败：${error}`);
      });
    }, interval);
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
  }

  /** 每条群消息都会进来；只关心有文本的用户消息 */
  observe(input: {
    groupId: string;
    userId: string;
    userName: string;
    content: string;
    messageId?: string;
    timestamp: number;
  }): void {
    const cfg = this.deps.getConfig(input.groupId).memory;
    if (!cfg.enabled) return;
    const content = input.content.trim();
    if (!content || !input.userId) return;

    const list = this.buffers.get(input.groupId) ?? [];
    list.push({ ...input, content });
    const rawMax = Number(cfg.maxBufferMessages);
    const max = Number.isFinite(rawMax)
      ? Math.max(10, Math.min(rawMax, 600))
      : 80;
    if (list.length > max) list.splice(0, list.length - max);
    this.buffers.set(input.groupId, list);

    // 轮廓计数：这里只累加，具体是否重画由窗口抽取时判断
    if (cfg.profileEnabled) {
      this.deps.store.bumpProfileSeen(
        input.groupId,
        input.userId,
        input.userName,
        Date.now(),
      );
    }
  }

  async flushDue(now = Date.now()): Promise<void> {
    if (this.disposed) return;
    const due: string[] = [];
    for (const [groupId, list] of this.buffers) {
      if (list.length === 0) continue;
      const cfg = this.deps.getConfig(groupId).memory;
      if (!cfg.enabled) continue;
      if ((this.nextAttemptAt.get(groupId) ?? 0) > now) continue;
      const oldest = list[0]?.timestamp ?? now;
      const windowMs = Math.max(1, cfg.windowMinutes) * 60_000;
      const enough = list.length >= Math.max(1, cfg.minMessagesPerWindow);
      if (!enough && now - oldest < windowMs * 2) continue;
      if (
        enough &&
        now - oldest < windowMs &&
        list.length < cfg.maxBufferMessages
      ) {
        continue;
      }
      due.push(groupId);
    }
    await Promise.all(due.map((groupId) => this.flushGroup(groupId)));
  }

  async flushGroup(groupId: string): Promise<void> {
    if (this.disposed || this.running.has(groupId)) return;
    const list = this.buffers.get(groupId);
    if (!list || list.length === 0) return;
    const cfg = this.deps.getConfig(groupId).memory;
    if (!cfg.enabled) return;

    this.running.add(groupId);
    const batch = list.splice(0, list.length);
    try {
      await this.extractMemories(groupId, cfg, batch);
      if (cfg.profileEnabled) await this.updateProfiles(groupId, cfg);
      this.nextAttemptAt.delete(groupId);
    } catch (error) {
      this.lastError = String(error);
      if (error instanceof UnusableOutputError) {
        // 模型这次没给出可用的 JSON：作废本窗口，不把消息塞回缓冲，避免每 10 分钟重烧一次
        this.deps.logger.warn(
          `[memory] 群 ${groupId} 本窗口作废：${error.message}`,
        );
      } else {
        // 网络 / 数据库这类可恢复失败：退避 10 分钟后带着原消息重试
        this.nextAttemptAt.set(groupId, Date.now() + 10 * 60_000);
        const current = this.buffers.get(groupId) ?? [];
        this.buffers.set(
          groupId,
          [...batch, ...current].slice(-cfg.maxBufferMessages),
        );
        this.deps.logger.warn(
          `[memory] 群 ${groupId} 抽取失败，稍后重试：${error}`,
        );
      }
    } finally {
      this.running.delete(groupId);
    }
  }

  private collectWindow(cfg: ChatConfig["memory"], batch: BufferedMessage[]) {
    const maxChars = Math.max(500, cfg.maxCharsPerWindow);
    const kept: BufferedMessage[] = [];
    let used = 0;
    for (let i = batch.length - 1; i >= 0; i--) {
      const message = batch[i];
      const line = `[${formatDateTime(message.timestamp)}] ${message.userName}(${message.userId}): ${message.content}`;
      if (used + line.length + 1 > maxChars && kept.length > 0) break;
      kept.unshift(message);
      used += line.length + 1;
    }
    const lines = kept.map(
      (message) =>
        `[${formatDateTime(message.timestamp)}] ${message.userName}(${message.userId})[id=${message.messageId ?? ""}]: ${message.content}`,
    );
    return { kept, lines };
  }

  private async extractMemories(
    groupId: string,
    cfg: ChatConfig["memory"],
    batch: BufferedMessage[],
  ): Promise<void> {
    const target = this.deps.getModel();
    if (!target) return;
    const { kept, lines } = this.collectWindow(cfg, batch);
    if (kept.length === 0) return;

    const existing = this.deps.store
      .listItems(groupId, { limit: 8 })
      .map((item) => `- ${item.content}`)
      .join("\n");

    const prompt = `${EXTRACT_PROMPT_HEADER}

群号：${groupId}
${existing ? `已有记忆（不要重复，可以补充细节）：\n${existing}\n` : ""}
聊天记录：
${lines.join("\n")}`;

    const raw = await this.generate(target, prompt);
    this.lastExtractAt = Date.now();

    if (!raw.trim()) {
      this.deps.store.recordWindow({
        groupId,
        windowStartAt: kept[0]?.timestamp ?? Date.now(),
        windowEndAt: kept[kept.length - 1]?.timestamp ?? Date.now(),
        status: "failed",
        itemCount: 0,
        updatedAt: Date.now(),
      });
      throw new UnusableOutputError(
        `模型返回空内容（思考吃满 ${WORKING_MAX_TOKENS} tokens）；可调小 maxCharsPerWindow 或换非推理模型`,
      );
    }

    const parsed = safeParse(raw);
    const list = readField(parsed, "memories");
    const candidates = Array.isArray(list)
      ? list
          .map((item) => normalizeCandidate(item))
          .filter((item): item is ExtractedMemory => Boolean(item))
      : [];

    let written = 0;
    for (const candidate of candidates) {
      if (candidate.confidence < cfg.minConfidence) continue;
      if (candidate.content.length < 12) continue;
      const aboutUserId =
        candidate.about && candidate.about !== "group"
          ? candidate.about
          : undefined;
      const aboutName = candidate.aboutName || nameOf(kept, aboutUserId);
      const item: MemoryItem = {
        groupId,
        userId: aboutUserId,
        userName: aboutName,
        kind: candidate.kind,
        content: candidate.content,
        detail: candidate.detail,
        quote: candidate.quote,
        importance: candidate.importance,
        confidence: candidate.confidence,
        sourceMessageIds: candidate.messageIds,
        windowStartAt: kept[0]?.timestamp,
        windowEndAt: kept[kept.length - 1]?.timestamp,
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const stored = await this.saveOrMerge(item);
      if (stored) written += 1;
    }

    this.deps.store.recordWindow({
      groupId,
      windowStartAt: kept[0]?.timestamp ?? Date.now(),
      windowEndAt: kept[kept.length - 1]?.timestamp ?? Date.now(),
      status: written > 0 ? "ok" : "skipped",
      itemCount: written,
      updatedAt: Date.now(),
    });

    if (written > 0) {
      this.deps.onChanged(groupId);
      this.deps.logger.info(
        `[memory] 群 ${groupId} 抽取 ${kept.length} 条消息 → ${written} 条记忆`,
      );
    }
  }

  private async saveOrMerge(item: MemoryItem): Promise<boolean> {
    const cfg = this.deps.getConfig(item.groupId).memory;
    try {
      const hits = await this.deps.index.searchItems(item.content, {
        groupId: item.groupId,
        ...(item.userId ? { userId: item.userId } : {}),
        topK: 1,
      });
      const best = hits[0];
      const docId = best ? String(best.docId ?? "") : "";
      const existingId = docId.startsWith("mem:") ? Number(docId.slice(4)) : 0;
      // 融合分会在单条候选时被归一化成 1，去重必须看原始余弦相似度
      const similarity = best ? (best.denseScore ?? 0) : 0;
      if (best && existingId > 0 && similarity >= 0.9) {
        const current = this.deps.store.getItem(existingId);
        if (current) {
          this.deps.store.updateItem(existingId, {
            content:
              item.content.length > current.content.length
                ? item.content
                : current.content,
            detail: longerOf(item.detail, current.detail),
            // 原话保留第一次抽到的，避免后来的补充把原始表述顶掉
            quote: current.quote || item.quote,
            importance: Math.max(current.importance, item.importance),
            confidence: Math.max(current.confidence, item.confidence),
          });
          const merged = this.deps.store.getItem(existingId);
          if (merged)
            await this.deps.index.syncItem(
              merged as MemoryItem & { id: number },
            );
          return true;
        }
      }
    } catch (error) {
      this.deps.logger.debug(`[memory] 相似度去重失败，按新增处理：${error}`);
    }

    const id = this.deps.store.insertItem(item);
    const stored = this.deps.store.getItem(id);
    if (!stored) return false;
    await this.deps.index.syncItem(stored as MemoryItem & { id: number });
    this.evictIfNeeded(item.groupId, cfg.maxItemsPerGroup);
    return true;
  }

  private evictIfNeeded(groupId: string, max: number): void {
    const removed = this.deps.store.trimGroup(groupId, max);
    if (removed.length > 0) {
      void this.deps.index.removeItems(removed);
      this.deps.logger.info(
        `[memory] 群 ${groupId} 超出上限，淘汰 ${removed.length} 条`,
      );
    }
  }

  private async updateProfiles(
    groupId: string,
    cfg: ChatConfig["memory"],
  ): Promise<void> {
    const target = this.deps.getModel();
    if (!target) return;
    const every = Math.max(10, cfg.profileUpdateEvery);
    // 第一次画像的门槛低一些，之后每积累 every 条才重画
    const firstAt = Math.max(5, Math.floor(every / 4));
    const profiles = this.deps.store.listProfiles(groupId, 200);
    const due = profiles
      .filter((profile) =>
        profile.profileSeen === 0
          ? profile.messagesSeen >= firstAt
          : profile.messagesSeen - profile.profileSeen >= every,
      )
      // 一个窗口里最多画 3 个人，避免活跃群一次触发几十次模型调用
      .sort((a, b) => b.messagesSeen - a.messagesSeen)
      .slice(0, 3);
    for (const profile of due) {
      try {
        await this.updateProfile(groupId, profile, target);
      } catch (error) {
        this.deps.logger.debug(`[memory] 更新轮廓失败：${error}`);
      }
    }
  }

  /** 一次调用拿正文；预算按「最大思考 + 正文」给，避免思考把正文挤没 */
  private async generate(
    target: ExtractModel,
    prompt: string,
  ): Promise<string> {
    const response = await target.instance.complete({
      model: target.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: WORKING_MAX_TOKENS,
    });
    return (response.content ?? "").trim();
  }

  private async updateProfile(
    groupId: string,
    profile: MemberProfile,
    target: ExtractModel,
  ): Promise<void> {
    const history = this.deps.store.listItems(groupId, {
      userId: profile.userId,
      limit: 8,
    });
    const lines = history
      .map(
        (item) =>
          `- ${item.content}${item.quote ? `（原话「${item.quote}」）` : ""}`,
      )
      .join("\n");
    const prompt = `${PROFILE_PROMPT_HEADER}

群号：${groupId}
成员：${profile.name || profile.userId}（${profile.userId}）
已有画像：
${JSON.stringify(
  {
    name: profile.name,
    aliases: profile.aliases,
    traits: profile.traits,
    habits: profile.habits,
    topics: profile.topics,
    relations: profile.relations,
    note: profile.note,
  },
  null,
  0,
)}
${lines ? `他最近的记忆：\n${lines}` : ""}`;

    const raw = await this.generate(target, prompt);
    if (!raw.trim()) return;
    const parsed = safeParse(raw);
    if (!isRecord(parsed)) return;

    const next: MemberProfile = {
      ...profile,
      name: cleanText(parsed.name, 40) || profile.name,
      aliases: mergeList(profile.aliases, cleanList(parsed.aliases, 6, 30), 8),
      traits: mergeList(profile.traits, cleanList(parsed.traits, 6, 40), 8),
      habits: mergeList(profile.habits, cleanList(parsed.habits, 5, 40), 6),
      topics: mergeList(profile.topics, cleanList(parsed.topics, 5, 40), 6),
      relations: mergeList(
        profile.relations,
        cleanList(parsed.relations, 4, 60),
        6,
      ),
      note: cleanText(parsed.note, 240) || profile.note,
      profileSeen: profile.messagesSeen,
      updatedAt: Date.now(),
    };
    this.deps.store.upsertProfile(next);
    await this.deps.index.syncProfile(next);
    this.deps.onChanged(groupId);
  }

  lastRunAt(): number {
    return this.lastExtractAt;
  }

  error(): string {
    return this.lastError;
  }
}

function safeParse(raw: string): unknown {
  try {
    return extractJsonObject(raw);
  } catch (error) {
    throw new UnusableOutputError(
      `模型返回的 JSON 无法解析（多半被截断）：${error}`,
    );
  }
}

function normalizeCandidate(raw: unknown): ExtractedMemory | null {
  if (!isRecord(raw)) return null;
  const content = cleanText(raw.content, 400);
  if (!content) return null;
  const kindRaw = cleanText(raw.kind, 20) as MemoryKind;
  const about = cleanText(raw.about, 64);
  return {
    about: about || undefined,
    aboutName: cleanText(raw.about_name, 40) || undefined,
    kind: KINDS.has(kindRaw) ? kindRaw : "other",
    content,
    detail: cleanText(raw.detail, 240) || undefined,
    quote: cleanText(raw.quote, 240) || undefined,
    importance: Math.round(clampNumber(raw.importance, 1, 5, 3)),
    confidence: clampNumber(raw.confidence, 0, 1, 0.6),
    messageIds: Array.isArray(raw.message_ids)
      ? raw.message_ids
          .map((id) => cleanText(id, 64))
          .filter(Boolean)
          .slice(0, 6)
      : [],
  };
}

function nameOf(batch: BufferedMessage[], userId: string | undefined): string {
  if (!userId) return "群";
  const found = batch.find((message) => message.userId === userId);
  return found?.userName || userId;
}

function longerOf(
  next: string | undefined,
  current: string | undefined,
): string | undefined {
  if (!next) return current;
  if (!current) return next;
  return next.length >= current.length ? next : current;
}

function mergeList(base: string[], incoming: string[], max: number): string[] {
  return Array.from(
    new Set([...incoming, ...base].map((item) => item.trim()).filter(Boolean)),
  ).slice(0, max);
}
