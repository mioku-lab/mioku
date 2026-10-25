import type { Bot, MessageSegment, MiokuContext } from "mioku";
import { summarizeMarkdown } from "../media/markdown-message";
import { createTypingDelay } from "./typing-delay";
import {
  atSegments,
  expandOutgoingLines,
  parseOutgoingLine,
  pokeUsers,
  recordSegment,
  renderMarkdownImage,
  resolveAudioSource,
  sendByTarget,
  sendMarkdownImage,
  type OutgoingLine,
  type SendOptions,
  type SendTarget,
} from "./outgoing";

const INLINE_AT = /\[at: ?(\d+)\]/g;

/** 发送一条回复文本（流式逐条发送、私聊回复都走这里） */
export async function sendTextMessage(
  ctx: MiokuContext,
  target: SendTarget,
  text: string,
  opts: SendOptions,
): Promise<void> {
  const typing = createTypingDelay(opts.config);
  try {
    const bot = ctx.pickBot(target.selfId);
    if (!bot) {
      ctx.logger.error(
        `[sendTextMessage] bot ${String(target.selfId)} not found, skip sending`,
      );
      return;
    }

    const lines = expandOutgoingLines(text);
    let pendingReply: string | undefined;
    let lastBasis = "";

    for (let j = 0; j < lines.length; j++) {
      const parsed = parseOutgoingLine(lines[j]);
      const { line, cleanText, atUsers, audioText, markdownContent } = parsed;
      const hasMore = j < lines.length - 1;

      if (parsed.quoteId !== undefined) pendingReply = parsed.quoteId;
      if (!parsed.hasPayload) {
        if (!hasMore) pendingReply = undefined;
        continue;
      }

      if (target.groupId) {
        await pokeUsers(bot, target.groupId, parsed.pokeUsers);
      }

      if (markdownContent) {
        const imagePath = await renderMarkdownImage(
          ctx,
          markdownContent,
          opts.config,
        );
        if (imagePath) {
          const prefix: MessageSegment[] = [];
          if (pendingReply !== undefined) {
            prefix.push(ctx.segment.reply(pendingReply));
            pendingReply = undefined;
          }
          prefix.push(...atSegments(ctx, atUsers, target.selfId));
          await sendMarkdownImage(ctx, bot, target, imagePath, prefix);
          lastBasis = summarizeMarkdown(markdownContent);
          await typing.pause(lastBasis || line, hasMore);
          continue;
        }
      }

      const audioSource = await resolveAudioSource(ctx, audioText, opts);
      const fallbackText = !audioSource && audioText ? audioText : undefined;
      const sendableText = markdownContent ?? cleanText;
      const segments: MessageSegment[] = [];
      if (pendingReply !== undefined) {
        segments.push(ctx.segment.reply(pendingReply));
        pendingReply = undefined;
      }

      if (atUsers.length > 0) {
        if (markdownContent) {
          segments.push(...atSegments(ctx, atUsers, target.selfId));
          if (sendableText) {
            segments.push(ctx.segment.text(sendableText));
          } else if (fallbackText) {
            segments.push(ctx.segment.text(fallbackText));
          }
          if (audioSource) segments.push(recordSegment(ctx, audioSource));
        } else {
          // @ 保持在原文中的位置
          segments.push(...inlineAtSegments(ctx, parsed, target.selfId));
          if (audioSource) {
            segments.push(recordSegment(ctx, audioSource));
          } else if (fallbackText) {
            segments.push(ctx.segment.text(fallbackText));
          }
        }
        // 带 @ 的消息只在群里有意义
        if (segments.length > 0 && target.groupId) {
          await sendToGroup(bot, target.groupId, segments);
          lastBasis = sendableText || fallbackText || audioText || line;
        }
      } else {
        if (sendableText) {
          segments.push(ctx.segment.text(sendableText));
        } else if (fallbackText) {
          segments.push(ctx.segment.text(fallbackText));
        }
        if (audioSource) segments.push(recordSegment(ctx, audioSource));
        if (segments.length > 0) {
          await sendByTarget(bot, target, segments);
          lastBasis = sendableText || fallbackText || audioText || line;
        }
      }

      await typing.pause(lastBasis || line, hasMore);
    }
  } catch (err) {
    ctx.logger.error("[sendTextMessage] error:", err);
  }
}

function sendToGroup(bot: Bot, groupId: string, segments: MessageSegment[]) {
  return bot.sendMessage({ type: "group", group_id: groupId }, segments);
}

function stripActionMarkers(text: string): string {
  return text
    .replace(/\[reply:[^\]\n]+\]/g, "")
    .replace(/\[poke:\d+\]/g, "")
    .replace(/\[audio:[^\]]+\]/gi, "")
    .trim();
}

function inlineAtSegments(
  ctx: MiokuContext,
  parsed: OutgoingLine,
  selfId: string,
): MessageSegment[] {
  const { line } = parsed;
  const segments: MessageSegment[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(INLINE_AT)) {
    const before = stripActionMarkers(line.slice(lastIndex, match.index));
    if (before) segments.push(ctx.segment.text(before));
    if (String(match[1]) !== String(selfId)) {
      segments.push(ctx.segment.at(String(match[1])));
    }
    lastIndex = match.index + match[0].length;
  }

  const after = stripActionMarkers(line.slice(lastIndex));
  if (after) segments.push(ctx.segment.text(after));
  return segments;
}
