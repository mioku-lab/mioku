import type { MessageEvent, MiokuContext } from "mioku";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import type { ChatPluginContext } from "../../context";
import type { ChatConfig, ReviewMessages, TargetMessage } from "../../types";
import type {
  CooldownBatch,
  PendingGroupMessage,
} from "../../manage/cooldown";
import type { DynamicDelayBatch } from "../../manage/queue-processor";
import {
  buildStructuredUserInputFromEvent,
  type StructuredUserInput,
} from "../../manage/group-structured-history";
import { segUrl } from "../../utils/segment";
import { eventUserId, senderName } from "../../utils/sender";
import { imagePart, textPart } from "../model-content";
import { createChatTarget } from "./target";
import { runChatTurn } from "./run-turn";

function toReviewMessages(messages: PendingGroupMessage[]): ReviewMessages {
  return {
    contents: messages.map((m) => m.content),
    userNames: messages.map((m) => m.userName),
    messageIds: messages.map((m) => m.messageId),
  };
}

function toStructuredInputs(
  messages: PendingGroupMessage[],
): StructuredUserInput[] {
  return messages.map((m) =>
    buildStructuredUserInputFromEvent(m.event, m.content, m.timestamp),
  );
}

function mergedTargetMessage(
  review: ReviewMessages,
  first: PendingGroupMessage,
  userRole: string,
): TargetMessage {
  return {
    userName: review.userNames.join(", "),
    userId: first.userId,
    userRole,
    content: review.contents.join("\n---\n"),
    messageId: first.messageId,
    timestamp: Date.now(),
  };
}

/** 冷却期间攒下的消息，冷却结束后一次回顾 */
export async function runCooldownReview(
  pluginCtx: ChatPluginContext,
  batch: CooldownBatch,
): Promise<void> {
  const { groupId, selfId, messages } = batch;
  const first = messages[0];
  const review = toReviewMessages(messages);

  await runChatTurn(pluginCtx, {
    source: "cooldown",
    target: createChatTarget(selfId, first.userId, groupId),
    cfg: pluginCtx.configProvider(groupId),
    event: first.event,
    authEvents: messages.map((m) => m.event),
    targetMessage: mergedTargetMessage(
      review,
      first,
      first.event.sender?.role || "member",
    ),
    reviewMessages: review,
    structuredInputs: toStructuredInputs(messages),
  });
}

/** 群里互动多时延迟回复，到期后合并处理 */
export async function runDynamicDelayBatch(
  pluginCtx: ChatPluginContext,
  batch: DynamicDelayBatch,
): Promise<void> {
  const { groupId, selfId, messages } = batch;
  pluginCtx.ctx.logger.info(
    `[DynamicDelay] group ${groupId} processes ${messages.length} delayed messages`,
  );
  pluginCtx.rateLimiter.clearGroupInteractions(groupId);

  const first = messages[0];
  const review = toReviewMessages(messages);
  await runChatTurn(pluginCtx, {
    source: "dynamic-delay",
    target: createChatTarget(selfId, first.userId, groupId),
    cfg: pluginCtx.configProvider(groupId),
    event: first.event,
    authEvents: messages.map((m) => m.event),
    targetMessage: mergedTargetMessage(review, first, "member"),
    reviewMessages: review,
    structuredInputs: toStructuredInputs(messages),
  });
}

/** 会话忙时排队的触发消息，轮到时合并成一轮 */
export async function runQueuedMessages(
  pluginCtx: ChatPluginContext,
  groupSessionId: string,
  selfId: string,
): Promise<void> {
  const { ctx, queueManager } = pluginCtx;
  try {
    const queue = queueManager.getQueue(groupSessionId);
    if (!queue || queue.length === 0) return;

    const groupId = String(groupSessionId.split(":")[1] ?? "").trim();
    if (!groupId) return;
    ctx.logger.info(
      `[Queue] group ${groupSessionId} batch ${queue.length} messages`,
    );

    const cfg = pluginCtx.configProvider(groupId);
    const contents: string[] = [];
    const structuredInputs: StructuredUserInput[] = [];
    for (const item of queue) {
      const { text, multimodal } = extractContent(ctx, item.event, cfg);
      const content = multimodal ? JSON.stringify(multimodal) : text;
      if (!content) continue;
      contents.push(content);
      structuredInputs.push(
        buildStructuredUserInputFromEvent(item.event, content, item.queuedAt),
      );
    }

    queueManager.clearQueue(groupSessionId);
    if (contents.length === 0) return;

    const firstEvent = queue[0].event;
    const userId = eventUserId(firstEvent);
    await runChatTurn(pluginCtx, {
      source: "queued-message",
      target: createChatTarget(selfId, userId, groupId),
      cfg,
      event: firstEvent,
      authEvents: queue.map((item) => item.event),
      targetMessage: {
        userName: senderName(firstEvent, String(firstEvent.user_id)),
        userId,
        userRole: firstEvent.sender?.role || "member",
        content: contents.join("\n"),
        messageId: firstEvent.message_id,
        timestamp: Date.now(),
      },
      structuredInputs,
    });
    ctx.logger.info(`[Queue] group ${groupSessionId} done`);
  } catch (err) {
    ctx.logger.error(err);
  }
}

/** 排队消息的正文；多模态时连同图片一起序列化 */
function extractContent(
  ctx: MiokuContext,
  e: MessageEvent,
  cfg: ChatConfig,
): { text: string; multimodal: ChatCompletionContentPart[] | null } {
  let text = "";
  try {
    text = ctx.text(e) || "";
  } catch {
    // 消息段异常时按空文本处理
  }

  if (!text.trim() && ctx.mentionedBots(e).length > 0) {
    text = "[@you with no text]";
  }
  if (!cfg.isMultimodal) return { text, multimodal: null };

  const parts: ChatCompletionContentPart[] = [];
  if (text) parts.push(textPart(text));

  let hasImage = false;
  for (const seg of e.message) {
    const url = seg.type === "image" ? segUrl(seg) : undefined;
    if (url) {
      parts.push(imagePart(url, "auto"));
      hasImage = true;
    } else if (seg.type === "record") {
      parts.push(textPart("[User sent a voice message]"));
    } else if (seg.type === "video") {
      parts.push(textPart("[User sent a video]"));
    }
  }

  return parts.length > 1 || hasImage
    ? { text, multimodal: parts }
    : { text, multimodal: null };
}
