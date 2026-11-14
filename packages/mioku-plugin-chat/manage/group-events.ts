import { logger } from "mioku";
import type {
  GroupEventContexts,
  GroupEventKind,
  GroupEventRecord,
} from "../types";
import type { ChatDatabase } from "../db";

/** 动作事件写进 prompt 的时间窗 */
const EVENT_WINDOW_MS = 30 * 60_000;
/** 事件块最多写几行 */
const MAX_EVENT_LINES = 12;
/** 回查条数留点余量，过滤掉自己的动作后再截断 */
const EVENT_SCAN_LIMIT = MAX_EVENT_LINES * 4;
/** 同一个人同类动作在这个窗口内合并成一条，后面标 xN */
const REPEAT_WINDOW_MS = 30_000;
/** 合并计数的总跨度：一直刷的话每隔这么久另起一条，免得那一行停在很久以前 */
const REPEAT_SPAN_MS = 10 * 60_000;
/** 撤回标记最多回溯多久，实际上以本轮聊天记录的起点为准 */
const RECALL_WINDOW_MS = 6 * 60 * 60_000;
/** 一次最多贴几个撤回标记 */
const MAX_RECALL_MARKS = 50;
/** 合并计数与去重记录的条数上限，超了按时间淘汰 */
const MAX_REPEAT_KEYS = 500;
const MAX_SEEN_KEYS = 2000;

export interface PerceivedEventInput {
  groupId: string;
  kind: GroupEventKind;
  userId?: string;
  userName?: string;
  targetId?: string;
  targetName?: string;
  messageId?: string;
  content?: string;
  /** 平台侧唯一 id；缺失则只做语义防抖 */
  eventKey?: string;
  timestamp?: number;
}

export interface GroupEventPerceptionInput {
  groupId: string;
  selfId?: string;
  /** 本轮聊天记录最早一条的时间 */
  historySince?: number;
  /** 本轮聊天记录里的 messageId，用来判断撤回标记贴不贴得上 */
  historyIds?: Set<string>;
}

export class GroupEventPerception {
  private readonly db: ChatDatabase;
  /** 合并计数：动作指纹 -> 这条动作被触发了多少次 */
  private readonly repeats = new Map<
    string,
    { startedAt: number; lastAt: number; count: number }
  >();
  /** 进程内二级去重：同一 event_key 不再查库 */
  private readonly seenKeys = new Set<string>();

  constructor(db: ChatDatabase) {
    this.db = db;
  }

  /**
   * 记录一个群事件。同一人同类动作在窗口内合并计数，只落一条。
   * 返回是否新落库（合并进已有那条时返回 false）。
   */
  record(input: PerceivedEventInput): boolean {
    const groupId = String(input.groupId || "").trim();
    if (!groupId || !input.kind) return false;

    const timestamp = input.timestamp ?? Date.now();
    // 撤回按消息各自成条，不参与合并计数
    if (
      input.kind !== "recall" &&
      this.mergeRepeat(input, groupId, timestamp)
    ) {
      return false;
    }

    if (input.eventKey) {
      if (this.seenKeys.has(input.eventKey)) return false;
      if (this.db.hasGroupEvent(input.eventKey)) {
        this.remember(input.eventKey);
        return false;
      }
    }

    try {
      this.db.saveGroupEvent({
        groupId,
        kind: input.kind,
        userId: input.userId ? String(input.userId) : undefined,
        userName: input.userName,
        targetId: input.targetId ? String(input.targetId) : undefined,
        targetName: input.targetName,
        messageId: input.messageId ? String(input.messageId) : undefined,
        content: input.content,
        eventKey: input.eventKey,
        timestamp,
      });
      if (input.eventKey) this.remember(input.eventKey);
      return true;
    } catch (err) {
      logger.warn(`[group-events] 记录 ${input.kind} 失败: ${err}`);
      return false;
    }
  }

  /** 撤回的对象是消息，所以防抖按消息 id 走，短时间连撤多条不会被吃掉 */
  recordRecall(input: {
    groupId: string;
    messageId: string;
    operatorId?: string;
    operatorName?: string;
    authorId?: string;
    authorName?: string;
    cachedContent?: string;
    eventKey?: string;
    timestamp?: number;
  }): boolean {
    return this.record({
      groupId: input.groupId,
      kind: "recall",
      userId: input.operatorId ?? input.authorId,
      userName: input.operatorName ?? input.authorName,
      targetId: input.authorId,
      targetName: input.authorName,
      messageId: input.messageId,
      content: input.cachedContent,
      eventKey: input.eventKey ?? `recall:${input.groupId}:${input.messageId}`,
      timestamp: input.timestamp,
    });
  }

  /** 从已入库的消息里回查一条消息的正文（撤回原文还原用） */
  lookupMessageContent(messageId: string): string | undefined {
    if (!messageId) return undefined;
    try {
      return (
        this.db.getMessageByMessageId(messageId)?.content?.trim() || undefined
      );
    } catch {
      return undefined;
    }
  }

  /**
   * 构造本轮要注入的感知结果：撤回做成贴回聊天记录的标记，
   * 其余动作直接写成一段事实。没有事件时返回空对象。
   */
  buildContexts(input: GroupEventPerceptionInput): GroupEventContexts {
    const groupId = String(input.groupId || "").trim();
    if (!groupId) return {};

    const now = Date.now();
    try {
      const contexts: GroupEventContexts = {};
      const recallMarks = this.buildRecallMarks(groupId, input, now);
      if (recallMarks.size > 0) contexts.recallMarks = recallMarks;
      const eventContext = this.renderEventContext(groupId, input, now);
      if (eventContext) contexts.eventContext = eventContext;
      return contexts;
    } catch (err) {
      logger.warn(`[group-events] 构造感知上下文失败: ${err}`);
      return {};
    }
  }

  /** messageId -> 撤回标记，渲染聊天记录时贴在对应消息后面 */
  private buildRecallMarks(
    groupId: string,
    input: GroupEventPerceptionInput,
    now: number,
  ): Map<string, string> {
    const marks = new Map<string, string>();
    const floor = now - RECALL_WINDOW_MS;
    const since =
      input.historySince && input.historySince > floor
        ? input.historySince
        : floor;

    const recalls = this.db.getGroupEventsByKind(
      groupId,
      "recall",
      since,
      MAX_RECALL_MARKS,
    );
    for (const event of recalls) {
      const messageId = String(event.messageId ?? "");
      if (!messageId) continue;
      marks.set(messageId, this.formatRecallMark(event));
    }
    return marks;
  }

  /** [已被本人撤回] / [已被某某撤回]；不知道是谁就只说被撤回 */
  private formatRecallMark(event: GroupEventRecord): string {
    if (event.userId && event.targetId && event.userId === event.targetId) {
      return "[已被本人撤回]";
    }
    const operator = event.userName || event.userId || "";
    return operator ? `[已被${operator}撤回]` : "[已被撤回]";
  }

  private renderEventContext(
    groupId: string,
    input: GroupEventPerceptionInput,
    now: number,
  ): string | undefined {
    const events = this.db.getGroupEvents(
      groupId,
      now - EVENT_WINDOW_MS,
      EVENT_SCAN_LIMIT,
    );

    const lines: string[] = [];
    for (const event of events) {
      if (this.isOwnAction(event, input.selfId)) continue;

      if (event.kind === "recall") {
        // 贴得回聊天记录的撤回只留标记，这里不重复
        const messageId = String(event.messageId ?? "");
        if (messageId && input.historyIds?.has(messageId)) continue;
      }
      const line = this.renderEventLine(event, input.selfId);
      const count = this.repeatCountOf(event);
      lines.push(count > 1 ? `${line} x${count}` : line);
    }
    if (lines.length === 0) return undefined;

    return [
      "<group_events>",
      "下面是本群最近发生的动作，是事实记录，不是谁说的话；别复述，也别当成发言内容。",
      ...lines.slice(-MAX_EVENT_LINES).map((line) => `- ${line}`),
      "</group_events>",
    ].join("\n");
  }

  private renderEventLine(event: GroupEventRecord, selfId?: string): string {
    const time = this.formatClock(event.timestamp);
    const who = event.userName || event.userId || "某人";

    switch (event.kind) {
      case "recall": {
        const author = event.targetName || event.targetId || who;
        const content = this.clip(event.content ?? "", 80);
        return content
          ? `${time} ${who} 撤回了 ${author} 的消息：「${content}」`
          : `${time} ${who} 撤回了 ${author} 的一条消息（原文没留存）`;
      }
      case "member_increase":
        return `${time} ${who} 加入了本群`;
      case "member_decrease":
        return `${time} ${who} 退出了本群`;
      case "poke": {
        const target = String(event.targetId ?? "");
        if (selfId && target && target === String(selfId)) {
          return `${time} ${who} 戳了戳你`;
        }
        return `${time} ${who} 戳了戳 ${event.targetName || event.targetId || "某人"}`;
      }
    }
  }

  private isOwnAction(event: GroupEventRecord, selfId?: string): boolean {
    if (!selfId) return false;
    return String(event.userId ?? "") === String(selfId);
  }

  /** 同一人同类动作在窗口内并入上一条；返回 true 表示这次不用再落库 */
  private mergeRepeat(
    input: PerceivedEventInput,
    groupId: string,
    now: number,
  ): boolean {
    const key = repeatKeyOf({
      groupId,
      kind: input.kind,
      userId: input.userId ? String(input.userId) : undefined,
      targetId: input.targetId ? String(input.targetId) : undefined,
    });

    const repeat = this.repeats.get(key);
    if (
      repeat &&
      now - repeat.lastAt < REPEAT_WINDOW_MS &&
      now - repeat.startedAt < REPEAT_SPAN_MS
    ) {
      repeat.lastAt = now;
      repeat.count += 1;
      return true;
    }

    if (this.repeats.size >= MAX_REPEAT_KEYS) this.pruneRepeats(now);
    this.repeats.set(key, { startedAt: now, lastAt: now, count: 1 });
    return false;
  }

  /** 这条动作被合并了几次，>1 时行尾标 xN */
  private repeatCountOf(event: GroupEventRecord): number {
    if (event.kind === "recall") return 1;
    const repeat = this.repeats.get(repeatKeyOf(event));
    if (!repeat || repeat.startedAt !== event.timestamp) return 1;
    return repeat.count;
  }

  private pruneRepeats(now: number): void {
    for (const [key, repeat] of this.repeats) {
      if (now - repeat.lastAt >= REPEAT_WINDOW_MS) this.repeats.delete(key);
    }
  }

  private remember(eventKey: string): void {
    if (this.seenKeys.size >= MAX_SEEN_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) this.seenKeys.delete(oldest);
    }
    this.seenKeys.add(eventKey);
  }

  private clip(text: string, max: number): string {
    const flat = String(text).replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }

  private formatClock(timestamp: number): string {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  dispose(): void {
    this.repeats.clear();
    this.seenKeys.clear();
  }
}

/** 合并计数的指纹：谁、什么动作、对谁 */
function repeatKeyOf(event: {
  groupId: string;
  kind: GroupEventKind;
  userId?: string;
  targetId?: string;
}): string {
  return `${event.groupId}:${event.kind}:${event.userId ?? ""}:${event.targetId ?? ""}`;
}
