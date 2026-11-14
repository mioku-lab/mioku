import type { MessageSegment, MiokuContext } from "mioku";
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
  sendMarkdownImage,
  type SendOptions,
} from "./outgoing";

export interface GroupReplyRequest extends SendOptions {
  selfId: string;
  groupId: string;
  messages: string[];
  /** 流式阶段已经发出的条目下标 */
  sentIndices?: Set<number>;
}

/** 把整轮回复逐行发到群里，返回每条回复对应的平台消息 id */
export async function sendGroupReply(
  ctx: MiokuContext,
  req: GroupReplyRequest,
): Promise<Array<string | undefined>> {
  const { selfId, groupId, messages, sentIndices, config } = req;
  const typing = createTypingDelay(config);
  const bot = ctx.pickBot(selfId);
  if (!bot) {
    ctx.logger.error(
      `[sendGroupReply] bot ${String(selfId)} not found, skip sending group message`,
    );
    return [];
  }
  if (messages.length === 0) return [];

  const target = { selfId, groupId };
  const sentMessageIds: Array<string | undefined> = new Array(messages.length);
  const recordSentId = (index: number, messageId?: string) => {
    if (messageId) sentMessageIds[index] ??= messageId;
  };

  for (let i = 0; i < messages.length; i++) {
    if (sentIndices?.has(i)) continue;

    const lines = expandOutgoingLines(messages[i]);
    let pendingReply: string | undefined;
    let lastBasis = "";

    for (let j = 0; j < lines.length; j++) {
      const parsed = parseOutgoingLine(lines[j]);
      const { line, cleanText, atUsers, audioText, markdownContent } = parsed;
      const hasMore = j < lines.length - 1;

      if (parsed.quoteId !== undefined) pendingReply = parsed.quoteId;
      if (!parsed.hasPayload) {
        // 末行只剩引用标记时丢弃，免得引用串到下一条回复
        if (!hasMore) pendingReply = undefined;
        continue;
      }

      await pokeUsers(bot, groupId, parsed.pokeUsers);

      const quoteId = pendingReply;
      const prefix: MessageSegment[] = [];
      if (quoteId !== undefined) {
        prefix.push(ctx.segment.reply(quoteId));
        pendingReply = undefined;
      }
      prefix.push(...atSegments(ctx, atUsers, selfId));

      if (markdownContent) {
        const imagePath = await renderMarkdownImage(ctx, markdownContent, config);
        if (imagePath) {
          recordSentId(
            i,
            await sendMarkdownImage(ctx, bot, target, imagePath, prefix),
          );
          lastBasis = summarizeMarkdown(markdownContent);
          await typing.pause(lastBasis || line, hasMore);
          continue;
        }
      }

      const sendableText = markdownContent ?? cleanText;
      const audioSource = await resolveAudioSource(ctx, audioText, req);
      const fallbackText = !audioSource && audioText ? audioText : undefined;
      const segments = [...prefix];
      if (sendableText) {
        segments.push(ctx.segment.text(sendableText));
      } else if (fallbackText) {
        segments.push(ctx.segment.text(fallbackText));
      }
      if (audioSource) segments.push(recordSegment(ctx, audioSource));

      if (segments.length > 0) {
        const sent = await bot.sendMessage(
          { type: "group", group_id: groupId },
          segments,
        );
        recordSentId(i, sent?.message_id);
        lastBasis = sendableText || fallbackText || audioText || line;
      }

      await typing.pause(lastBasis || line, hasMore);
    }

    await typing.pause(lastBasis || messages[i], i < messages.length - 1);
  }

  return sentMessageIds;
}
