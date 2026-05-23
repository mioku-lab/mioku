import { logger, MiokiContext } from "mioki";
import type { AIInstance } from "mioku";
import type { ChatConfig, ChatMessage } from "../types";
import {
  getCachedHistoryCardTag,
  getCachedHistoryForwardTag,
  getCachedHistoryVideoTag,
  type HistoryMediaProcessingOptions,
} from "../core/media/history-media";
import { getImageTag } from "../core/media/image-analyzer";

const HISTORY_MEDIA_CONCURRENCY = 8;

export function shouldTrigger(
  e: any,
  text: string,
  cfg: ChatConfig,
  ctx: MiokiContext,
): boolean {
  if (e.message_type === "private") return false;

  // Only check if message @s the bot (seg format: {type: "at", qq: "123456"})
  const atSeg = e.message?.find((seg: any) => seg.type === "at");
  return !!(atSeg && String(atSeg.qq) === String(e.self_id));
}

/**
 * Check if the message quotes a bot message.
 * Returns the quoted message content if quoting bot, null otherwise.
 */
export async function isQuotingBot(
  e: any,
  ctx: MiokiContext,
): Promise<{ quoted: true; messageId: string; content: string } | null> {
  if (e.quote_id) {
    try {
      const quoteMsg = await ctx.getQuoteMsg(e);
      if (quoteMsg && String(quoteMsg.sender.user_id) === String(e.self_id)) {
        const quotedText = quoteMsg.message
          ?.filter((s: any) => s.type === "text")
          .map((s: any) => s.text)
          .join("");
        if (quotedText) {
          return { quoted: true, messageId: e.quote_id, content: quotedText };
        }
        return null;
      }
    } catch (err) {
      logger.error(err);
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
  ctx: MiokiContext,
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
      const quotedMsg = await ctx.getQuoteMsg(e);
      if (quotedMsg && quotedMsg.message) {
        const senderName = quotedMsg.sender.nickname;
        // 提取文本内容
        const textContent = quotedMsg.message
          .filter((s: any) => s.type === "text")
          .map((s: any) => s.text || "")
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

export function isGroupAllowed(groupId: number, cfg: ChatConfig): boolean {
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
  ctx: MiokiContext,
): { text: string; multimodal: any[] | null } {
  let text = "";
  try {
    text = ctx.text(e) || "";
  } catch {}

  // If text is empty but user @'d the bot, describe the action
  if (!text.trim() && e.message) {
    const hasAt = e.message.some(
      (seg: any) => seg.type === "at" && String(seg.qq) === String(e.self_id),
    );
    if (hasAt) {
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
  groupId: number,
  ctx: MiokiContext,
  selfId: number,
): Promise<"owner" | "admin" | "member"> {
  try {
    const memberInfo = await ctx
      .pickBot(selfId)
      .getGroupMemberInfo(groupId, selfId);
    return (memberInfo.role as "owner" | "admin" | "member") || "member";
  } catch {
    return "member";
  }
}

/**
 * 从 OneBot API 获取群聊历史消息
 * 返回格式化为 ChatMessage 数组
 */
export async function getGroupHistory(
  groupId: number,
  ctx: MiokiContext,
  count: number = 100,
  selfId: number,
  db?: {
    getBotMessages(groupId: number, limit: number): ChatMessage[];
    getImageByHash?(hash: string): any;
    getImageByUrl?(url: string): any;
    getMediaSummary?(key: string): any;
    saveMediaSummary?(summary: any): void;
    getStoredGroupNoticeMessages?(
      groupId: number,
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
    userId: number;
    userName: string;
    userRole: string;
    content: string;
    messageId: number;
    timestamp: number;
  }>
> {
  // 先获取 bot 从数据库发送的消息
  const botMessages: Array<{
    userId: number;
    userName: string;
    userRole: string;
    content: string;
    messageId: number;
    timestamp: number;
  }> = [];

  if (db) {
    const storedBotMessages = db.getBotMessages(groupId, count);
    for (const msg of storedBotMessages) {
      botMessages.push({
        userId: msg.userId ?? 0,
        userName: msg.userName || "Miku",
        userRole: msg.userRole || "member",
        content: msg.content,
        messageId: msg.messageId ?? 0,
        timestamp: msg.timestamp,
      });
    }

    const storedNoticeMessages =
      db.getStoredGroupNoticeMessages?.(groupId, Math.min(count, 20)) || [];
    for (const msg of storedNoticeMessages) {
      botMessages.push({
        userId: msg.userId ?? 0,
        userName: msg.userName || String(msg.userId || "unknown"),
        userRole: msg.userRole || "member",
        content: msg.content,
        messageId: msg.messageId ?? 0,
        timestamp: msg.timestamp,
      });
    }
  }

  try {
    const bot = ctx.pickBot(selfId) as any;
    const historyMediaOptions: HistoryMediaProcessingOptions = {
      ai: mediaOptions?.ai,
      workingModel: mediaOptions?.workingModel,
      multimodalWorkingModel: mediaOptions?.multimodalWorkingModel,
      db:
        db?.getMediaSummary && db?.saveMediaSummary
          ? {
              getMediaSummary: db.getMediaSummary.bind(db),
              saveMediaSummary: db.saveMediaSummary.bind(db),
            }
          : undefined,
      bot,
      groupId,
    };
    // 调用 OneBot API 获取群聊历史
    const result = await bot.api("get_group_msg_history", {
      group_id: String(groupId),
      message_seq: "0",
      count: Math.min(count, 200), // 最多获取200条
      reverse_order: false,
      disable_get_url: false,
      parse_mult_msg: true,
      quick_reply: false,
    });
    const messages = result?.messages || result?.data?.messages || [];
    if (!Array.isArray(messages)) {
      logger.warn("[getGroupHistory] API 返回格式异常:", result);
      return botMessages;
    }

    const botUin = selfId;

    // 格式化消息
    const formattedResults = await mapWithConcurrency(
      messages,
      HISTORY_MEDIA_CONCURRENCY,
      async (msg) => {
        // 跳过自己的消息
        if (String(msg.user_id) === String(botUin)) {
          return null;
        }

        // 提取文本内容
        let content = "";
        try {
          if (
            msg.message &&
            Array.isArray(msg.message) &&
            msg.message.length > 0
          ) {
            const textSegs = msg.message.filter(
              (seg: any) => seg.type === "text",
            );
            const textContent = textSegs
              .map((seg: any) => seg.data?.text || "")
              .join("")
              .trim();
            const atSegs = msg.message.filter((seg: any) => seg.type === "at");
            const atContent = atSegs
              .map((seg: any) => {
                // OneBot v11 格式: seg.qq
                const atUid =
                  seg.qq || seg.data?.qq || seg.data?.id || seg.data?.user_id;
                if (!atUid) {
                  return null;
                }
                if (atUid === "all" || atUid === "everyone") {
                  return "@全体成员";
                }
                return `@${atUid}`;
              })
              .filter((v: string | null) => v !== null)
              .join(" ");
            const parts: string[] = [];
            if (atContent) {
              parts.push(atContent);
            }
            if (textContent) {
              parts.push(textContent);
            }

            // 处理图片消息
            const imageSegs = msg.message.filter(
              (seg: any) => seg.type === "image",
            );
            if (imageSegs.length > 0) {
              for (const imageSeg of imageSegs) {
                const imageUrl =
                  (imageSeg as any).url || (imageSeg as any).data?.url;
                if (imageUrl) {
                  parts.push(
                    db?.getImageByHash
                      ? await getImageTag(String(imageUrl), db as any)
                      : "[image]",
                  );
                }
              }
            }

            // 处理视频消息：历史里只读取已缓存摘要，不触发旧视频分析。
            const videoSegs = msg.message.filter(
              (seg: any) => seg.type === "video",
            );
            for (const videoSeg of videoSegs) {
              const videoUrl =
                (videoSeg as any).url || (videoSeg as any).data?.url;
              if (videoUrl) {
                const tag = await getCachedHistoryVideoTag(
                  String(videoUrl),
                  historyMediaOptions,
                );
                parts.push(tag);
              } else {
                parts.push("[video]");
              }
            }

            // 处理合并转发消息
            const forwardSegs = msg.message.filter(
              (seg: any) => seg.type === "forward",
            );
            for (const forwardSeg of forwardSegs) {
              const forwardId =
                (forwardSeg as any).id || (forwardSeg as any).data?.id;
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

            // 处理 XML/JSON/轻应用/Ark 卡片消息
            const cardSegs = msg.message.filter((seg: any) =>
              ["xml", "json", "lightapp", "ark"].includes(seg.type),
            );
            for (const cardSeg of cardSegs) {
              const cardData =
                (cardSeg as any).data?.data ||
                (cardSeg as any).data?.xml ||
                (cardSeg as any).data ||
                (cardSeg as any).xml ||
                "";
              if (cardData) {
                parts.push(
                  getCachedHistoryCardTag(
                    typeof cardData === "string"
                      ? cardData
                      : JSON.stringify(cardData),
                    historyMediaOptions,
                  ),
                );
              } else {
                parts.push("[card]");
              }
            }

            if (parts.length > 0) {
              content = parts.join(" ");
            } else if (Array.isArray(msg.message)) {
              const segTypes = msg.message.map((seg: any) => seg.type);
              const nonTextTypes = segTypes.filter(
                (t: string) => t !== "text" && t !== "at",
              );
              if (nonTextTypes.length > 0) {
                content = `[${nonTextTypes.join(", ")}]`;
              } else {
                return null;
              }
            }
          }
        } catch (err) {
          logger.error("[getGroupHistory] process message error:", err);
          return null;
        }

        // 跳过空消息
        if (!content.trim()) {
          return null;
        }

        return {
          userId: msg.user_id,
          userName:
            msg.sender?.card || msg.sender?.nickname || String(msg.user_id),
          userRole: msg.sender?.role || "member",
          content,
          messageId: msg.message_id,
          timestamp: msg.time ? msg.time * 1000 : Date.now(),
        };
      },
    );
    const formatted = formattedResults.filter(
      (
        msg,
      ): msg is {
        userId: number;
        userName: string;
        userRole: string;
        content: string;
        messageId: number;
        timestamp: number;
      } => Boolean(msg),
    );

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
