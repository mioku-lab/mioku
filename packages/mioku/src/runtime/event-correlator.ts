import { createHash } from "node:crypto";

import type {
  Event,
  MessageEvent,
  MessageSegment,
  NoticeEvent,
  RequestEvent,
} from "../adapter";
import type { Logger } from "../logger";

const MESSAGE_TTL_MS = 15_000;
const EVENT_TTL_MS = 60_000;
const PRUNE_INTERVAL = 128;
const MAX_SIZE = 4096;
const MAX_SEGMENTS = 16;
const MAX_TEXT = 256;
const HEX32 = /[0-9a-f]{32}/i;
const HEX40 = /[0-9a-f]{40}/i;
const MEDIA_URL_QUERY_KEYS = ["fileid", "file_id", "md5", "fid"];

/** 一个参与投递这条事件的 (适配器, bot) 组合 */
export interface CorrelationParticipant {
  readonly adapter: string;
  readonly botId?: string;
  readonly eventType: string;
  readonly messageId?: string;
}

/** 同一条逻辑事件被多个适配器/bot 投递时的关联记录 */
export interface CorrelationRecord {
  readonly key: string;
  /** 首个到达的参与方 */
  readonly primary: CorrelationParticipant;
  /** 观察到这条事件的全部参与方，首个即 primary */
  readonly participants: readonly CorrelationParticipant[];
  readonly firstSeenAt: number;
  readonly expiresAt: number;
}

/** 单个事件在关联组里的位置 */
export interface EventObservation {
  readonly record: CorrelationRecord;
  /** 是否为该关联组首个到达的事件 */
  readonly primary: boolean;
  /** 是否为关联组内后续到达的重复投递 */
  readonly duplicate: boolean;
}

export interface CorrelationStats {
  /** 当前保留的关联组数量 */
  readonly groups: number;
  /** 累计观察的事件数 */
  readonly observed: number;
  /** 累计判定的重复投递数 */
  readonly duplicates: number;
  /** 累计因超限被淘汰的关联组数 */
  readonly evicted: number;
}

interface Group {
  key: string;
  expiresAt: number;
  firstSeenAt: number;
  primary: CorrelationParticipant;
  participants: CorrelationParticipant[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hashString = (input: string): string =>
  createHash("sha1").update(input).digest("hex").slice(0, 20);

/** 稳定序列化：对象键排序、无多余空白，忽略跨适配器的排版差异 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
};

/** 结构化载荷（json/xml/ark）的稳定摘要 */
const structuredDigest = (raw: unknown): string => {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    try {
      value = JSON.parse(trimmed);
    } catch {
      return `s:${hashString(trimmed.slice(0, MAX_TEXT * 4))}`;
    }
  }
  return `j:${hashString(canonicalJson(value))}`;
};

/** 去掉会过期/随会话变化的查询参数，保留跨适配器稳定的媒体定位 */
const normalizeMediaUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    const kept = new URLSearchParams();
    for (const key of MEDIA_URL_QUERY_KEYS) {
      const value = url.searchParams.get(key);
      if (value) kept.set(key, value);
    }
    const query = kept.toString();
    return `${url.host}${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return raw;
  }
};

const firstHex = (value: unknown, pattern: RegExp): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const match = value.match(pattern);
  return match ? match[0].toLowerCase() : undefined;
};

/**
 * 媒体段的内容摘要：优先内容哈希（md5/sha1），其次是文件名里嵌的 md5，
 * 再次是规范化 URL。都拿不到时返回空串，由调用方退化为「只看段类型」。
 */
const mediaDigest = (data: Record<string, unknown>): string => {
  const md5 = firstHex(data.md5, HEX32);
  if (md5) return `h:${md5}`;
  const sha1 = firstHex(data.sha1, HEX40);
  if (sha1) return `h:${sha1}`;
  for (const key of ["file_unique", "file_id", "fid", "id", "file", "name"]) {
    const hex = firstHex(data[key], HEX32);
    if (hex) return `h:${hex}`;
  }
  const url = data.url;
  if (typeof url === "string" && url) return `u:${normalizeMediaUrl(url)}`;
  for (const key of ["file", "file_id", "fid", "id", "name"]) {
    const value = data[key];
    if (typeof value === "string" && value) return `r:${value.toLowerCase()}`;
  }
  return "";
};

/** 只在载荷跨协议一致时才使用摘要的段类型 */
const DIGEST_MEDIA_TYPES = new Set(["image", "flash"]);

const segmentSignature = (segment: MessageSegment): string => {
  const data = isRecord(segment.data) ? segment.data : {};
  switch (segment.type) {
    case "text": {
      const text = typeof data.text === "string" ? data.text : "";
      return `t:${text.slice(0, MAX_TEXT)}`;
    }
    case "at": {
      const target = data.qq ?? data.target;
      return `a:${target == null ? "" : String(target)}`;
    }
    case "face": {
      const id = data.id ?? data.face;
      return `f:${id == null ? "" : String(id)}`;
    }
    case "json":
    case "xml":
    case "ark": {
      const digest = structuredDigest(data.data ?? data.content ?? data);
      return digest ? `${segment.type}:${digest}` : segment.type;
    }
    default: {
      if (DIGEST_MEDIA_TYPES.has(segment.type)) {
        const digest = mediaDigest(data);
        return digest ? `${segment.type}:${digest}` : segment.type;
      }
      return segment.type;
    }
  }
};

const contentSignatureOf = (event: MessageEvent): string => {
  const parts: string[] = [];
  for (const segment of event.message) {
    if (parts.length >= MAX_SEGMENTS) break;
    if (segment.type === "reply") continue;
    parts.push(segmentSignature(segment));
  }
  return parts.join("|");
};

const messageKeyOf = (event: MessageEvent): string => {
  const type = event.message_type ?? "";
  const scope = event.group_id ?? event.user_id ?? "";
  const sender = event.user_id ?? event.sender?.user_id ?? "";
  return ["m", type, scope, sender, contentSignatureOf(event)].join("|");
};

const noticeKeyOf = (event: NoticeEvent): string =>
  [
    "n",
    event.identity.event_type,
    event.notice_type ?? "",
    event.sub_type ?? "",
    event.group_id ?? "",
    event.user_id ?? "",
    event.operator_id ?? "",
    event.identity.timestamp == null
      ? ""
      : Math.floor(event.identity.timestamp / 1000),
  ].join("|");

const requestKeyOf = (event: RequestEvent): string =>
  [
    "r",
    event.identity.event_type,
    event.request_type ?? "",
    event.sub_type ?? "",
    event.group_id ?? "",
    event.user_id ?? "",
    event.comment ?? "",
    event.identity.timestamp == null
      ? ""
      : Math.floor(event.identity.timestamp / 1000),
  ].join("|");

const participantOf = (event: Event): CorrelationParticipant => ({
  adapter: event.identity.adapter,
  botId: event.identity.bot_id,
  eventType: event.identity.event_type,
  messageId: event.identity.message_id ?? event.identity.native_event_id,
});

const sameParticipant = (
  a: CorrelationParticipant,
  b: CorrelationParticipant,
): boolean =>
  a.adapter === b.adapter &&
  (a.botId ?? "") === (b.botId ?? "") &&
  (a.messageId ?? "") === (b.messageId ?? "");

/**
 * 跨适配器事件关联器
 */
export class EventCorrelator {
  readonly #groups = new Map<string, Group>();
  readonly #byEvent = new WeakMap<Event, EventObservation>();
  readonly #logger: Logger | undefined;
  readonly #maxSize: number;
  #inserts = 0;
  #observed = 0;
  #duplicates = 0;
  #evicted = 0;

  constructor(options: { logger?: Logger; maxSize?: number } = {}) {
    this.#logger = options.logger;
    this.#maxSize = options.maxSize ?? MAX_SIZE;
  }

  /** 观察一个事件，登记它所属的关联组并返回其定位（同一事件只登记一次） */
  observe(event: Event): EventObservation | null {
    const cached = this.#byEvent.get(event);
    if (cached) return cached;
    const located = this.#locate(event);
    if (!located) return null;
    const { key, ttl } = located;
    const now = Date.now();
    this.#observed++;

    let group = this.#groups.get(key);
    let duplicate = false;
    if (group && group.expiresAt >= now) {
      duplicate = true;
      this.#duplicates++;
      const participant = participantOf(event);
      if (
        !group.participants.some((item) => sameParticipant(item, participant))
      ) {
        group.participants.push(participant);
      }
      this.#logger?.debug(
        `去重命中: key=${key} adapter=${participant.adapter} bot=${participant.botId ?? ""} primary=${group.primary.adapter}:${group.primary.botId ?? ""}`,
      );
    } else {
      const participant = participantOf(event);
      group = {
        key,
        expiresAt: now + ttl,
        firstSeenAt: now,
        primary: participant,
        participants: [participant],
      };
      this.#groups.set(key, group);
      this.#inserts++;
      if (
        this.#inserts >= PRUNE_INTERVAL ||
        this.#groups.size > this.#maxSize
      ) {
        this.#inserts = 0;
        this.#prune(now);
      }
    }

    const observation: EventObservation = {
      record: group,
      primary: !duplicate,
      duplicate,
    };
    this.#byEvent.set(event, observation);
    return observation;
  }

  /** 读取某事件此前登记的关联定位（未登记或已过期时返回 undefined） */
  observationOf(event: Event): EventObservation | undefined {
    const observation = this.#byEvent.get(event);
    if (!observation) return undefined;
    if (observation.record.expiresAt < Date.now()) return undefined;
    return observation;
  }

  /** 该事件是否属于关联组里后续到达的重复投递（未登记时会先登记） */
  isDuplicate(event: Event): boolean {
    return this.observe(event)?.duplicate === true;
  }

  stats(): CorrelationStats {
    return {
      groups: this.#groups.size,
      observed: this.#observed,
      duplicates: this.#duplicates,
      evicted: this.#evicted,
    };
  }

  clear(): void {
    this.#groups.clear();
  }

  #locate(event: Event): { key: string; ttl: number } | null {
    if (event.kind === "message") {
      return { key: messageKeyOf(event), ttl: MESSAGE_TTL_MS };
    }
    if (event.kind === "notice") {
      return { key: noticeKeyOf(event), ttl: EVENT_TTL_MS };
    }
    if (event.kind === "request") {
      return { key: requestKeyOf(event), ttl: EVENT_TTL_MS };
    }
    return null;
  }

  #prune(now: number): void {
    for (const [key, group] of this.#groups) {
      if (group.expiresAt < now) this.#groups.delete(key);
    }
    if (this.#groups.size <= this.#maxSize) return;
    const drop = this.#groups.size - this.#maxSize;
    let dropped = 0;
    for (const key of this.#groups.keys()) {
      this.#groups.delete(key);
      this.#evicted++;
      if (++dropped >= drop) break;
    }
  }
}
