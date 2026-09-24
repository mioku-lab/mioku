import { HistoryMessage, logger, type MiokuContext } from "mioku";
import type { AIInstance, Bot } from "mioku";

import type {
  ChatConfig,
  ChatMessage,
  ImageRecord,
  MediaSummaryRecord,
} from "../types";
import {
  getCachedHistoryCardTag,
  getCachedHistoryForwardTag,
  getCachedHistoryVideoTag,
  getSegmentSourceCandidates,
  type HistoryMediaProcessingOptions,
  type MediaMessageSegment,
} from "../core/media/history-media";
import { calculateImageHash } from "../core/media/image-analyzer";

const HISTORY_MEDIA_CONCURRENCY = 8;

export function shouldTrigger(
  e: any,
  text: string,
  cfg: ChatConfig,
  ctx: MiokuContext,
): boolean {
  if (e.message_type === "private") return false;

  return ctx.mentionedBots(e).length > 0;
}

/**
 * Check if the message quotes a bot message.
 * Returns the quoted message content if quoting bot, null otherwise.
 */
export async function isQuotingBot(
  e: any,
  ctx: MiokuContext,
): Promise<{ quoted: true; messageId: string; content: string } | null> {
  if (e.quote_id) {
    try {
      const quoteMsg = await fetchQuotedMessage(e, ctx);
      const quotedUserId = String(quoteMsg?.sender?.user_id ?? "");
      const quotingAnyBot =
        quoteMsg != null &&
        quotedUserId !== "" &&
        ctx.bots.some((bot) => String(bot.bot_id) === quotedUserId);
      if (quotingAnyBot) {
        const quotedText = quoteMsg!.message
          ?.filter((s: any) => s.type === "text")
          .map((s: any) => String(s.data?.text ?? s.text ?? ""))
          .join("");
        if (quotedText) {
          return { quoted: true, messageId: e.quote_id, content: quotedText };
        }
        return null;
      }
    } catch (err) {
      ctx.logger.error(err);
    }
  }
  return null;
}

/**
 * Extract quoted content from a message (regardless of who was quoted).
 * Returns the quoted text, message_id, sender name, and optional image URL, or null if no reply segment.
 */
export async function getQuotedContent(
  e: any,
  ctx: MiokuContext,
): Promise<
  | {
      messageId: string;
      senderName: string;
      content: string;
      imageUrl?: string;
    }
  | null
  | undefined
> {
  if (e.quote_id) {
    try {
      const quotedMsg = await fetchQuotedMessage(e, ctx);
      if (quotedMsg && quotedMsg.message) {
        const senderName = quotedMsg.sender?.nickname || "";
        // 提取文本内容
        const textContent = quotedMsg.message
          .filter((s: any) => s.type === "text")
          .map((s: any) => String(s.data?.text ?? s.text ?? ""))
          .join("");

        // 检测是否有图片
        let imageUrl: string | undefined;
        const imageSeg = quotedMsg.message.find((s: any) => s.type === "image");
        if (imageSeg && typeof imageSeg === "object") {
          imageUrl = (imageSeg as any).url || (imageSeg as any).data?.url;
        }

        return {
          messageId: String(e.quote_id),
          senderName,
          content: textContent,
          imageUrl,
        };
      } else return null;
    } catch (err) {
      // ignore
    }
  }
}

export function isGroupAllowed(groupId: string, cfg: ChatConfig): boolean {
  if (cfg.whitelistGroups.length > 0) {
    return cfg.whitelistGroups.includes(groupId);
  }
  if (cfg.blacklistGroups.length > 0) {
    return !cfg.blacklistGroups.includes(groupId);
  }
  return true;
}

export function extractContent(
  e: any,
  cfg: ChatConfig,
  ctx: MiokuContext,
): { text: string; multimodal: any[] | null } {
  let text = "";
  try {
    text = ctx.text(e) || "";
  } catch {}

  // If text is empty but the message @'d a connected bot, describe the action
  if (!text.trim() && e.message) {
    if (ctx.mentionedBots(e).length > 0) {
      text = "[@you with no text]";
    }
  }

  if (!cfg.isMultimodal) return { text, multimodal: null };

  const parts: any[] = [];
  if (text) {
    parts.push({ type: "text", text });
  }

  if (e.message) {
    for (const seg of e.message) {
      // Image seg format: {type: "image", url: "...", file: "..."}
      if (seg.type === "image" && (seg.url || seg.data?.url)) {
        parts.push({
          type: "image_url",
          image_url: { url: seg.url || seg.data.url, detail: "auto" },
        });
      } else if (seg.type === "record") {
        parts.push({ type: "text", text: "[User sent a voice message]" });
      } else if (seg.type === "video") {
        parts.push({ type: "text", text: "[User sent a video]" });
      }
    }
  }

  if (parts.length > 1 || parts.some((p) => p.type === "image_url")) {
    return { text, multimodal: parts };
  }
  return { text, multimodal: null };
}

async function mapWithConcurrency<T, R>(
  items: T[],
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

export async function getBotRole(
  groupId: string,
  ctx: MiokuContext,
  selfId: string,
): Promise<"owner" | "admin" | "member"> {
  try {
    const bot = ctx.pickBot(selfId);
    if (!bot) return "member";
    const memberInfo = await bot.getMemberInfo(groupId, selfId);
    return (memberInfo?.role as "owner" | "admin" | "member") || "member";
  } catch {
    return "member";
  }
}

interface FormattedHistoryMessage {
  userId: string;
  userName: string;
  userRole: string;
  content: string;
  messageId: string;
  timestamp: number;
  role: "user" | "assistant";
}

interface HistoryFormatContext {
  db:
    | {
        getImageByUrl?(url: string): ImageRecord | null;
        getImageByHash?(hash: string): ImageRecord | null;
        saveImage?(image: ImageRecord): void;
      }
    | undefined;
  historyMediaOptions: HistoryMediaProcessingOptions;
  botUin: string;
  /** 本运行时全部已连接 bot 的 id：这些账号的消息一律不作为用户历史（防 bot 互触循环） */
  botIds: Set<string>;
  memberNameCache: Map<string, string>;
  hashLookupCache: Map<string, string | null>;
}

async function resolveMemberName(
  userId: string | number,
  ctx: HistoryFormatContext,
): Promise<string> {
  const key = String(userId);
  if (ctx.memberNameCache.has(key)) {
    return ctx.memberNameCache.get(key) || key;
  }
  ctx.memberNameCache.set(key, key);
  try {
    const bot = ctx.historyMediaOptions.bot as Bot | undefined;
    if (!bot) return key;
    const info = await bot.getMemberInfo(
      ctx.historyMediaOptions.groupId!,
      userId,
    );
    const name = info?.card || info?.nickname || key;
    ctx.memberNameCache.set(key, name);
    return name;
  } catch {
    return key;
  }
}

function extractQuotedText(messageSegs: any): string {
  // icqq 的 source.message 是 brief 字符串；onebot 是 segment 数组
  if (typeof messageSegs === "string") return messageSegs.trim();
  if (!Array.isArray(messageSegs) || messageSegs.length === 0) return "";
  const parts: string[] = [];
  for (const seg of messageSegs) {
    if (!seg || typeof seg !== "object") continue;
    const type = seg.type;
    const data = seg.data || {};
    if (type === "text") {
      const t = String(data.text || "").trim();
      if (t) parts.push(t);
    } else if (type === "at") {
      const uid = seg.qq || data.qq || data.id || data.user_id;
      if (uid === "all" || uid === "everyone") parts.push("@全体成员");
      else if (uid) parts.push(`@${uid}`);
    } else if (type === "image") {
      parts.push("[image]");
    } else if (type === "video") {
      parts.push("[video]");
    } else if (type === "reply") {
      continue;
    } else {
      parts.push(`[${type}]`);
    }
  }
  return parts.join(" ").trim();
}

/** 引用关系：id 必有，发送者与原文可能缺失（例如 onebot 历史只给 id） */
interface ReplyRef {
  id: string;
  name?: string;
  text?: string;
}

function extractReplyRef(
  source: any,
  ctx: HistoryFormatContext,
): ReplyRef | null {
  if (!source || typeof source !== "object") return null;
  const sourceId = source.id ?? source.message_id ?? source.message_seq;
  const sourceUserId = source.user_id;
  const sourceNickname =
    source.sender?.card || source.sender?.nickname || source.nickname;
  const sourceText = extractQuotedText(source.message);

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
    name = ctx.memberNameCache.get(String(sourceUserId)) || String(sourceUserId);
  }
  if (!name) name = sourceNickname || undefined;

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
  return ref.name ? `${head} ${ref.name}: "${ref.text}"` : `${head}: "${ref.text}"`;
}

function summarizeQuotedContent(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

async function getImageTagWithHashCache(
  imageUrl: string,
  db: NonNullable<HistoryFormatContext["db"]>,
  ctx: HistoryFormatContext,
): Promise<string> {
  const exact = db.getImageByUrl?.(imageUrl);
  if (exact) return `[image:${exact.description}]`;

  let hash = ctx.hashLookupCache.get(`hash:${imageUrl}`);
  if (hash === undefined) {
    hash = (await calculateImageHash(imageUrl)) || null;
    ctx.hashLookupCache.set(`hash:${imageUrl}`, hash);
  }
  if (!hash) return "[image]";

  const byHash = db.getImageByHash?.(hash);
  if (byHash) {
    try {
      db.saveImage?.({
        hash: byHash.hash,
        url: imageUrl,
        type: "image",
        description: byHash.description,
        createdAt: byHash.createdAt,
      });
    } catch {
      // best-effort URL caching for next call
    }
    return `[image:${byHash.description}]`;
  }

  return "[image]";
}

async function formatHistoryMessage(
  msg: HistoryMessage,
  ctx: HistoryFormatContext,
): Promise<{ formatted: FormattedHistoryMessage; reply: ReplyRef | null } | null> {
  // 自己或本运行时其它 bot 的消息不作为用户历史，
  // 否则多 bot 同群时会把彼此的消息当作用户接话，形成循环触发
  if (String(msg.user_id) === String(ctx.botUin)) return null;
  if (ctx.botIds.has(String(msg.user_id))) return null;

  const reply = extractReplyRef((msg as { source?: unknown }).source, ctx);

  let content = "";
  try {
    content = await buildMessageContent(msg, ctx);
  } catch (err) {
    logger.error("[getGroupHistory] process message error:", err);
    return null;
  }

  if (!content.trim() && !reply) return null;

  return {
    formatted: {
      userId: String(msg.user_id ?? "").trim(),
      userName: msg.nickname || String(msg.user_id ?? "unknown"),
      userRole: "member",
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
  msg: any,
  ctx: HistoryFormatContext,
): Promise<string> {
  if (!msg.message || !Array.isArray(msg.message) || msg.message.length === 0) {
    return "";
  }
  const { db, historyMediaOptions } = ctx;
  const parts: string[] = [];

  const textSegs = msg.message.filter((seg: any) => seg.type === "text");
  const textContent = textSegs
    .map((seg: any) => seg.data?.text || "")
    .join("")
    .trim();

  const atSegments = msg.message.filter((seg: any) => seg.type === "at");
  const atDisplayParts: string[] = [];
  for (const seg of atSegments) {
    const atUid = seg.qq || seg.data?.qq || seg.data?.id || seg.data?.user_id;
    if (!atUid) continue;
    if (atUid === "all" || atUid === "everyone") {
      atDisplayParts.push("@全体成员");
      continue;
    }
    const name = await resolveMemberName(String(atUid), ctx);
    atDisplayParts.push(`@${name}(${atUid})`);
  }
  const atContent = atDisplayParts.join(" ");

  if (atContent) parts.push(atContent);
  if (textContent) parts.push(textContent);

  const imageSegments = msg.message.filter((seg: any) => seg.type === "image");
  if (imageSegments.length > 0 && db?.getImageByUrl) {
    const imageTags = await Promise.all(
      imageSegments.map(async (seg: any) => {
        const imageUrl = seg.url || seg.data?.url;
        if (!imageUrl) return "[image]";

        const cached = ctx.hashLookupCache.get(imageUrl);
        if (cached !== undefined) {
          return cached;
        }

        const tag = await getImageTagWithHashCache(
          String(imageUrl),
          db as any,
          ctx,
        );
        ctx.hashLookupCache.set(imageUrl, tag);
        return tag;
      }),
    );
    for (const tag of imageTags) parts.push(tag);
  } else if (imageSegments.length > 0) {
    for (const _ of imageSegments) parts.push("[image]");
  }

  for (const videoSeg of msg.message.filter(
    (seg: MediaMessageSegment) => seg.type === "video",
  )) {
    const videoSources = getSegmentSourceCandidates(videoSeg);
    if (videoSources.length > 0) {
      parts.push(
        await getCachedHistoryVideoTag(videoSources, historyMediaOptions),
      );
    } else {
      parts.push("[video]");
    }
  }

  for (const forwardSeg of msg.message.filter(
    (seg: any) => seg.type === "forward",
  )) {
    const forwardId = forwardSeg.id || forwardSeg.data?.id;
    if (forwardId) {
      parts.push(
        await getCachedHistoryForwardTag(
          String(forwardId),
          historyMediaOptions,
        ),
      );
    } else {
      parts.push("[forward]");
    }
  }

  for (const cardSeg of msg.message.filter((seg: any) =>
    ["xml", "json", "lightapp", "ark"].includes(seg.type),
  )) {
    const cardData =
      cardSeg.data?.data ||
      cardSeg.data?.xml ||
      cardSeg.data ||
      cardSeg.xml ||
      "";
    if (cardData) {
      parts.push(
        getCachedHistoryCardTag(
          typeof cardData === "string" ? cardData : JSON.stringify(cardData),
          historyMediaOptions,
        ),
      );
    } else {
      parts.push("[card]");
    }
  }

  if (parts.length > 0) return parts.join(" ");

  const segTypes = msg.message.map((seg: any) => seg.type);
  const nonTextTypes = segTypes.filter(
    (t: string) => t !== "text" && t !== "at",
  );
  return nonTextTypes.length > 0 ? `[${nonTextTypes.join(", ")}]` : "";
}

/**
 * 从 OneBot API 获取群聊历史消息
 * 返回格式化为 ChatMessage 数组
 */
export async function getGroupHistory(
  groupId: string,
  ctx: MiokuContext,
  count: number = 100,
  selfId: string,
  db?: {
    getBotMessages(groupId: string, limit: number): ChatMessage[];
    getImageByHash?(hash: string): ImageRecord | null;
    getImageByUrl?(url: string): ImageRecord | null;
    getMediaSummary?(key: string): MediaSummaryRecord | null;
    saveMediaSummary?(summary: MediaSummaryRecord): void;
    getMediaSummaryBySource?(sourceKey: string): MediaSummaryRecord | null;
    saveMediaSummarySource?(sourceKey: string, summaryKey: string): void;
    getStoredGroupNoticeMessages?(
      groupId: string,
      limit?: number,
    ): ChatMessage[];
  },
  mediaOptions?: {
    ai?: AIInstance;
    workingModel?: string;
    multimodalWorkingModel?: string;
  },
): Promise<
  Array<{
    userId: string;
    userName: string;
    userRole: string;
    content: string;
    messageId: string;
    timestamp: number;
    role: "user" | "assistant";
  }>
> {
  // 先获取 bot 从数据库发送的消息
  const botMessages: Array<{
    userId: string;
    userName: string;
    userRole: string;
    content: string;
    messageId: string;
    timestamp: number;
    role: "user" | "assistant";
  }> = [];

  if (db) {
    const storedBotMessages = db.getBotMessages(groupId, count);
    for (const msg of storedBotMessages) {
      botMessages.push({
        userId: String(msg.userId ?? ""),
        userName: msg.userName || "Miku",
        userRole: msg.userRole || "member",
        content: msg.content,
        messageId: msg.messageId ?? "",
        timestamp: msg.timestamp,
        role: "assistant",
      });
    }

    const storedNoticeMessages =
      db.getStoredGroupNoticeMessages?.(groupId, Math.min(count, 20)) || [];
    for (const msg of storedNoticeMessages) {
      botMessages.push({
        userId: String(msg.userId ?? ""),
        userName: msg.userName || String(msg.userId ?? "unknown"),
        userRole: msg.userRole || "member",
        content: msg.content,
        messageId: msg.messageId ?? "",
        timestamp: msg.timestamp,
        role: "user",
      });
    }
  }

  try {
    const bot = ctx.pickBot(selfId);
    const historyMediaOptions: HistoryMediaProcessingOptions = {
      bot,
      ai: mediaOptions?.ai,
      workingModel: mediaOptions?.workingModel,
      multimodalWorkingModel: mediaOptions?.multimodalWorkingModel,
      db:
        db?.getMediaSummary && db?.saveMediaSummary
          ? {
              getMediaSummary: db.getMediaSummary.bind(db),
              saveMediaSummary: db.saveMediaSummary.bind(db),
              getMediaSummaryBySource: db.getMediaSummaryBySource?.bind(db),
              saveMediaSummarySource: db.saveMediaSummarySource?.bind(db),
            }
          : undefined,
      groupId,
    };
    const messages = bot
      ? await bot.getHistory(
          { type: "group", group_id: groupId },
          undefined,
          Math.min(count, 200),
        )
      : [];

    const botUin = selfId;
    const botIds = new Set<string>(ctx.bots.map((b) => String(b.bot_id)));
    botIds.add(String(botUin));
    const memberNameCache = new Map<string, string>();
    const hashLookupCache = new Map<string, string | null>();

    for (const m of messages) {
      const uid = m.user_id;
      const senderName = m.nickname;
      if (uid != null && senderName && !memberNameCache.has(String(uid))) {
        memberNameCache.set(String(uid), String(senderName));
      }
    }

    const formatCtx: HistoryFormatContext = {
      db,
      historyMediaOptions,
      botUin,
      botIds,
      memberNameCache,
      hashLookupCache,
    };

    const processed = await mapWithConcurrency(
      messages,
      HISTORY_MEDIA_CONCURRENCY,
      (msg: any) => formatHistoryMessage(msg, formatCtx),
    );
    const entries = processed.filter(
      (
        item,
      ): item is {
        formatted: FormattedHistoryMessage;
        reply: ReplyRef | null;
      } => Boolean(item),
    );

    // 引用关系单独渲染：被引用的消息若也在本批历史里，直接补上发送者与原文
    const byMessageId = new Map<string, FormattedHistoryMessage>();
    for (const item of entries) {
      if (item.formatted.messageId) {
        byMessageId.set(item.formatted.messageId, item.formatted);
      }
    }
    for (const botMessage of botMessages) {
      if (botMessage.messageId && !byMessageId.has(botMessage.messageId)) {
        byMessageId.set(botMessage.messageId, botMessage);
      }
    }

    const formatted = entries.map(({ formatted: message, reply }) => {
      if (!reply) return message;
      const quoted = reply.id ? byMessageId.get(reply.id) : undefined;
      const annotation = renderReplyRef({
        ...reply,
        name: reply.name ?? quoted?.userName,
        text:
          reply.text ??
          (quoted ? summarizeQuotedContent(quoted.content) || undefined : undefined),
      });
      return {
        ...message,
        content: message.content
          ? `${annotation} ${message.content}`
          : annotation,
      };
    });

    // 合并 bot 消息
    const allMessages = [...botMessages, ...formatted];
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    // 如果超过 count，截取最新的
    if (allMessages.length > count) {
      return allMessages.slice(-count);
    }

    return allMessages;
  } catch (err) {
    console.error("获取群聊历史失败:", err);
    return botMessages;
  }
}

export function buildChatMessageFromEvent(
  e: any,
  text: string,
  isGroup: boolean,
  groupId: string | undefined,
): ChatMessage {
  const userId: string = e.user_id || e.sender?.user_id;
  return {
    sessionId: groupId ? `group:${groupId}` : `personal:${userId}`,
    role: "user" as const,
    content: text,
    userId,
    userName: e.sender?.card || e.sender?.nickname || String(userId),
    userRole: e.sender?.role || "member",
    userTitle: (e.sender as any)?.title || undefined,
    groupId,
    groupName: isGroup ? e.group_name : undefined,
    timestamp: Date.now(),
    messageId: e.message_id,
  };
}

export function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  );
}

async function fetchQuotedMessage(
  e: any,
  ctx: MiokuContext,
): Promise<{
  message: any[];
  sender?: { user_id?: string; nickname?: string };
} | null> {
  const bot = e?.bot ?? ctx.pickBot(e?.self_id ?? "");
  if (!bot || !e?.quote_id) return null;
  try {
    const result = await bot.getMessage(e.quote_id);
    return result ?? null;
  } catch {
    return null;
  }
}
