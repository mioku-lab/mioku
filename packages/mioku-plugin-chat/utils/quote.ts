import type { MessageEvent, MessageGetResult, MiokuContext } from "mioku";
import { readField } from "./record";
import { segText, segUrl } from "./segment";

export interface QuotedContent {
  messageId: string;
  senderName: string;
  senderId: string;
  /** 被引用的是不是某个已连接的机器人 */
  fromBot: boolean;
  content: string;
  imageUrl?: string;
}

function quotedSenderId(msg: MessageGetResult): string {
  return String(readField(msg.sender, "user_id") ?? "");
}

function quotedText(msg: MessageGetResult): string {
  return msg.message
    .filter((seg) => seg.type === "text")
    .map((seg) => segText(seg))
    .join("");
}

function isConnectedBot(ctx: MiokuContext, userId: string): boolean {
  return userId !== "" && ctx.bots.some((bot) => String(bot.bot_id) === userId);
}

/** 引用的是机器人自己说的话时，返回被引用的文本 */
export async function isQuotingBot(
  e: MessageEvent,
  ctx: MiokuContext,
): Promise<{ quoted: true; messageId: string; content: string } | null> {
  if (!e.quote_id) return null;
  try {
    const quoteMsg = await ctx.getQuoteMsg(e);
    if (!quoteMsg || !isConnectedBot(ctx, quotedSenderId(quoteMsg))) {
      return null;
    }
    const content = quotedText(quoteMsg);
    return content ? { quoted: true, messageId: e.quote_id, content } : null;
  } catch (err) {
    ctx.logger.error(err);
    return null;
  }
}

/** 引用消息的内容（不论引用的是谁） */
export async function getQuotedContent(
  e: MessageEvent,
  ctx: MiokuContext,
): Promise<QuotedContent | null> {
  if (!e.quote_id) return null;
  try {
    const quotedMsg = await ctx.getQuoteMsg(e);
    if (!quotedMsg?.message) return null;
    const senderId = quotedSenderId(quotedMsg);
    const imageSeg = quotedMsg.message.find((seg) => seg.type === "image");
    return {
      messageId: String(e.quote_id),
      senderName: String(readField(quotedMsg.sender, "nickname") || ""),
      senderId,
      fromBot: isConnectedBot(ctx, senderId),
      content: quotedText(quotedMsg),
      imageUrl: imageSeg ? segUrl(imageSeg) : undefined,
    };
  } catch {
    return null;
  }
}
