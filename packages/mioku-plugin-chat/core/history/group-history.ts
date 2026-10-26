import type { Bot, HistoryMessage, Logger, MiokuContext } from "mioku";
import type { ChatMessage, ChatTarget } from "../../types";
import type { ChatDatabase } from "../../db";
import {
  getCachedHistoryCardTag,
  getCachedHistoryForwardTag,
  getCachedHistoryVideoTag,
  getSegmentSourceCandidates,
  type HistoryMediaProcessingOptions,
} from "../media/history-media";
import { calculateImageHash } from "../media/image-analyzer";
import { isRecord, readField } from "../../utils/record";
import {
  segAtTarget,
  segData,
  segField,
  segTop,
  segUrl,
} from "../../utils/segment";

const HISTORY_MEDIA_CONCURRENCY = 8;
const HISTORY_FETCH_LIMIT = 200;
const CARD_SEGMENT_TYPES = new Set(["xml", "json", "lightapp", "ark"]);

export interface GroupHistoryEntry {
  userId: string;
  userName: string;
  userRole: string;
  userTitle?: string;
  content: string;
  messageId: string;
  timestamp: number;
  role: "user" | "assistant";
}

interface MemberRole {
  role: string;
  title?: string;
}

/** 引用关系：id 必有，发送者与原文可能缺失（例如 onebot 历史只给 id） */
interface ReplyRef {
  id: string;
  name?: string;
  text?: string;
}

interface FormattedEntry {
  entry: GroupHistoryEntry;
  reply: ReplyRef | null;
}

/** 单次拉历史时共享的查询缓存 */
interface HistoryFormatContext {
  db: ChatDatabase;
  bot: Bot | undefined;
  groupId: string;
  logger: Logger;
  mediaOptions: HistoryMediaProcessingOptions;
  botIds: Set<string>;
  memberNames: Map<string, string>;
  memberRoles: Map<string, MemberRole>;
  memberRolesPending: Map<string, Promise<MemberRole>>;
  imageTags: Map<string, string>;
  imageHashes: Map<string, string | null>;
}

/** 平台群聊历史 + 本地存的机器人发言，按时间合并成最近 count 条 */
export async function fetchGroupHistory(
  ctx: MiokuContext,
  db: ChatDatabase,
  target: { groupId: string; selfId: string },
  count: number,
): Promise<GroupHistoryEntry[]> {
  const { groupId, selfId } = target;
  const botMessages: GroupHistoryEntry[] = db
    .getBotMessages(groupId, count)
    .map((msg) => ({
      userId: String(msg.userId ?? ""),
      userName: msg.userName || "Miku",
      userRole: msg.userRole || "member",
      userTitle: msg.userTitle,
      content: msg.content,
      messageId: msg.messageId ?? "",
      timestamp: msg.timestamp,
      role: "assistant",
    }));

  try {
    const bot = ctx.pickBot(selfId);
    const messages = bot
      ? await bot.getHistory(
          { type: "group", group_id: groupId },
          undefined,
          Math.min(count, HISTORY_FETCH_LIMIT),
        )
      : [];

    const botIds = new Set<string>(ctx.bots.map((b) => String(b.bot_id)));
    botIds.add(String(selfId));
    const memberNames = new Map<string, string>();
    for (const m of messages) {
      if (m.user_id != null && m.nickname && !memberNames.has(m.user_id)) {
        memberNames.set(String(m.user_id), String(m.nickname));
      }
    }

    const formatCtx: HistoryFormatContext = {
      db,
      bot,
      groupId,
      logger: ctx.logger,
      mediaOptions: { bot, db, groupId },
      botIds,
      memberNames,
      memberRoles: new Map(),
      memberRolesPending: new Map(),
      imageTags: new Map(),
      imageHashes: new Map(),
    };

    const processed = await mapWithConcurrency(
      messages,
      HISTORY_MEDIA_CONCURRENCY,
      (msg) => formatHistoryMessage(msg, formatCtx),
    );
    const entries = processed.filter(
      (item): item is FormattedEntry => item !== null,
    );

    // 被引用的消息也在本批历史里时，补上发送者与原文
    const byMessageId = new Map<string, GroupHistoryEntry>();
    for (const { entry } of entries) {
      if (entry.messageId) byMessageId.set(entry.messageId, entry);
    }
    for (const botMessage of botMessages) {
      if (botMessage.messageId && !byMessageId.has(botMessage.messageId)) {
        byMessageId.set(botMessage.messageId, botMessage);
      }
    }

    const formatted = entries.map(({ entry, reply }) => {
      if (!reply) return entry;
      const quoted = reply.id ? byMessageId.get(reply.id) : undefined;
      const annotation = renderReplyRef({
        ...reply,
        name: reply.name ?? quoted?.userName,
        text:
          reply.text ??
          (quoted
            ? summarizeQuotedContent(quoted.content) || undefined
            : undefined),
      });
      return {
        ...entry,
        content: entry.content ? `${annotation} ${entry.content}` : annotation,
      };
    });

    const all = [...botMessages, ...formatted];
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all.length > count ? all.slice(-count) : all;
  } catch (err) {
    ctx.logger.error(`获取群聊历史失败: ${err}`);
    return botMessages;
  }
}

/** 群聊历史转成会话消息；私聊返回空 */
export async function loadChatHistory(
  ctx: MiokuContext,
  db: ChatDatabase,
  target: ChatTarget,
  count: number,
): Promise<ChatMessage[]> {
  const { groupId } = target;
  if (!groupId) return [];
  const entries = await fetchGroupHistory(
    ctx,
    db,
    { groupId, selfId: target.selfId },
    count,
  );
  return entries.map((msg) => ({
    sessionId: target.sessionId,
    role: msg.role,
    content: msg.content,
    userId: msg.userId,
    userName: msg.userName,
    userRole: msg.userRole,
    userTitle: msg.userTitle,
    groupId,
    timestamp: msg.timestamp,
    messageId: msg.messageId,
  }));
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );

  return results;
}

async function resolveMemberName(
  userId: string,
  ctx: HistoryFormatContext,
): Promise<string> {
  const cached = ctx.memberNames.get(userId);
  if (cached !== undefined) return cached || userId;
  ctx.memberNames.set(userId, userId);
  try {
    if (!ctx.bot) return userId;
    const info = await ctx.bot.getMemberInfo(ctx.groupId, userId);
    const name = info?.card || info?.nickname || userId;
    ctx.memberNames.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function resolveMemberRole(
  userId: string,
  ctx: HistoryFormatContext,
): Promise<MemberRole> {
  const cached = ctx.memberRoles.get(userId);
  if (cached !== undefined) return cached;

  const pending = ctx.memberRolesPending.get(userId);
  if (pending) return pending;

  const lookup = (async (): Promise<MemberRole> => {
    const fallback: MemberRole = { role: "member" };
    try {
      if (!ctx.bot) return fallback;
      const info = await ctx.bot.getMemberInfo(ctx.groupId, userId);
      const title = info?.title;
      return {
        role: String(info?.role ?? "member") || "member",
        title: typeof title === "string" && title.trim() ? title.trim() : undefined,
      };
    } catch {
      return fallback;
    }
  })();

  ctx.memberRolesPending.set(userId, lookup);
  try {
    const resolved = await lookup;
    ctx.memberRoles.set(userId, resolved);
    return resolved;
  } finally {
    ctx.memberRolesPending.delete(userId);
  }
}

function formatAtTarget(uid: unknown): string | null {
  if (uid === "all" || uid === "everyone") return "@全体成员";
  return uid ? `@${uid}` : null;
}

function extractQuotedText(messageSegs: unknown): string {
  // icqq 的 source.message 是 brief 字符串；onebot 是 segment 数组
  if (typeof messageSegs === "string") return messageSegs.trim();
  if (!Array.isArray(messageSegs) || messageSegs.length === 0) return "";
  const parts: string[] = [];
  for (const seg of messageSegs) {
    if (!isRecord(seg)) continue;
    const type = seg.type;
    if (type === "text") {
      const t = String(segData(seg, "text") || "").trim();
      if (t) parts.push(t);
    } else if (type === "at") {
      const at = formatAtTarget(segAtTarget(seg));
      if (at) parts.push(at);
    } else if (type === "image") {
      parts.push("[image]");
    } else if (type === "video") {
      parts.push("[video]");
    } else if (type !== "reply") {
      parts.push(`[${type}]`);
    }
  }
  return parts.join(" ").trim();
}

function extractReplyRef(
  source: unknown,
  ctx: HistoryFormatContext,
): ReplyRef | null {
  if (!source || typeof source !== "object") return null;
  const sourceId =
    readField(source, "id") ??
    readField(source, "message_id") ??
    readField(source, "message_seq");
  const sourceUserId = readField(source, "user_id");
  const sender = readField(source, "sender");
  const sourceNickname =
    readField(sender, "card") ||
    readField(sender, "nickname") ||
    readField(source, "nickname");
  const sourceText = extractQuotedText(readField(source, "message"));

  if (
    sourceId == null &&
    sourceUserId == null &&
    !sourceText &&
    !sourceNickname
  ) {
    return null;
  }

  let name: string | undefined;
  if (sourceUserId != null) {
    name = ctx.memberNames.get(String(sourceUserId)) || String(sourceUserId);
  }
  if (!name) name = sourceNickname ? String(sourceNickname) : undefined;

  return {
    id: sourceId != null ? String(sourceId) : "",
    name,
    text: sourceText || undefined,
  };
}

function renderReplyRef(ref: ReplyRef): string {
  const head = `↪ reply to #${ref.id || "?"}`;
  if (!ref.name && !ref.text) return head;
  if (!ref.text) return `${head} ${ref.name}`;
  return ref.name
    ? `${head} ${ref.name}: "${ref.text}"`
    : `${head}: "${ref.text}"`;
}

function summarizeQuotedContent(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

async function getImageTag(
  imageUrl: string,
  ctx: HistoryFormatContext,
): Promise<string> {
  const cachedTag = ctx.imageTags.get(imageUrl);
  if (cachedTag !== undefined) return cachedTag;

  const tag = await lookupImageTag(imageUrl, ctx);
  ctx.imageTags.set(imageUrl, tag);
  return tag;
}

async function lookupImageTag(
  imageUrl: string,
  ctx: HistoryFormatContext,
): Promise<string> {
  const { db } = ctx;
  const exact = db.getImageByUrl(imageUrl);
  if (exact) return `[image:${exact.description}]`;

  let hash = ctx.imageHashes.get(imageUrl);
  if (hash === undefined) {
    hash = (await calculateImageHash(imageUrl)) || null;
    ctx.imageHashes.set(imageUrl, hash);
  }
  if (!hash) return "[image]";

  const byHash = db.getImageByHash(hash);
  if (!byHash) return "[image]";
  try {
    db.saveImage({
      hash: byHash.hash,
      url: imageUrl,
      type: "image",
      description: byHash.description,
      createdAt: byHash.createdAt,
    });
  } catch {
    // 只是为下次按 URL 命中，失败无妨
  }
  return `[image:${byHash.description}]`;
}

async function formatHistoryMessage(
  msg: HistoryMessage,
  ctx: HistoryFormatContext,
): Promise<FormattedEntry | null> {
  const userId = String(msg.user_id ?? "");
  if (ctx.botIds.has(userId)) return null;

  const reply = extractReplyRef(msg.source, ctx);

  let content = "";
  try {
    content = await buildMessageContent(msg, ctx);
  } catch (err) {
    ctx.logger.error(`[getGroupHistory] process message error: ${err}`);
    return null;
  }

  if (!content.trim() && !reply) return null;

  const resolved = await resolveMemberRole(userId, ctx);

  return {
    entry: {
      userId: userId.trim(),
      userName: msg.nickname || String(msg.user_id ?? "unknown"),
      userRole: resolved.role,
      userTitle: resolved.title,
      content,
      messageId:
        msg.message_id != null && msg.message_id !== ""
          ? String(msg.message_id)
          : "",
      timestamp: msg.time ?? Date.now(),
      role: "user",
    },
    reply,
  };
}

async function buildMessageContent(
  msg: HistoryMessage,
  ctx: HistoryFormatContext,
): Promise<string> {
  const segments = msg.message;
  if (!Array.isArray(segments) || segments.length === 0) return "";
  const parts: string[] = [];

  const atParts: string[] = [];
  const textParts: string[] = [];
  const imageUrls: Array<string | undefined> = [];
  const videoSegs: unknown[] = [];
  const forwardIds: Array<string | undefined> = [];
  const cards: unknown[] = [];
  const otherTypes: string[] = [];

  for (const seg of segments) {
    const type = seg.type;
    if (type === "text") {
      textParts.push(String(segData(seg, "text") || ""));
      continue;
    }
    if (type === "at") {
      const uid = segAtTarget(seg);
      if (!uid) continue;
      if (uid === "all" || uid === "everyone") {
        atParts.push("@全体成员");
        continue;
      }
      const name = await resolveMemberName(String(uid), ctx);
      atParts.push(`@${name}(${uid})`);
      continue;
    }
    otherTypes.push(type);
    if (type === "image") imageUrls.push(segUrl(seg));
    else if (type === "video") videoSegs.push(seg);
    else if (type === "forward") {
      const id = segField(seg, "id");
      forwardIds.push(id ? String(id) : undefined);
    } else if (CARD_SEGMENT_TYPES.has(type)) {
      cards.push(
        segData(seg, "data") ||
          segData(seg, "xml") ||
          segTop(seg, "data") ||
          segTop(seg, "xml") ||
          "",
      );
    }
  }

  const atContent = atParts.join(" ");
  const textContent = textParts.join("").trim();
  if (atContent) parts.push(atContent);
  if (textContent) parts.push(textContent);

  const imageTags = await Promise.all(
    imageUrls.map((url) =>
      url ? getImageTag(String(url), ctx) : Promise.resolve("[image]"),
    ),
  );
  parts.push(...imageTags);

  for (const seg of videoSegs) {
    const sources = getSegmentSourceCandidates(seg);
    parts.push(
      sources.length > 0
        ? await getCachedHistoryVideoTag(sources, ctx.mediaOptions)
        : "[video]",
    );
  }

  for (const forwardId of forwardIds) {
    parts.push(
      forwardId
        ? await getCachedHistoryForwardTag(forwardId, ctx.mediaOptions)
        : "[forward]",
    );
  }

  for (const cardData of cards) {
    parts.push(
      cardData
        ? getCachedHistoryCardTag(
            typeof cardData === "string" ? cardData : JSON.stringify(cardData),
            ctx.mediaOptions,
          )
        : "[card]",
    );
  }

  if (parts.length > 0) return parts.join(" ");
  return otherTypes.length > 0 ? `[${otherTypes.join(", ")}]` : "";
}
