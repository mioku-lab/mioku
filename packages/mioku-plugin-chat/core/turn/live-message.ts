import type { Bot, MessageEvent } from "mioku";
import type { ChatPluginContext, ChatRuntimeState } from "../../context";
import type { ChatConfig, ChatTarget, QuoteInfo, TargetMessage } from "../../types";
import { mainModelSupportsVision } from "../../utils/model";
import { getQuotedContent, type QuotedContent } from "../../utils/quote";
import { toOptionalId } from "../../utils/record";
import { segUrl } from "../../utils/segment";
import { eventUserId, senderName, senderTitle } from "../../utils/sender";
import { createChatTarget } from "./target";
import { runChatTurn } from "./run-turn";

/** 真实群聊/私聊消息触发的一轮回复 */
export async function processChat(
  pluginCtx: ChatPluginContext,
  e: MessageEvent,
  runtimeState: ChatRuntimeState,
  replyBot?: Bot,
): Promise<void> {
  const { ctx } = pluginCtx;
  const groupId =
    e.message_type === "group" ? toOptionalId(e.group_id) : undefined;
  const userId = eventUserId(e);
  const selfId = String(replyBot?.bot_id ?? e.self_id);
  const cfg = await pluginCtx.getConfig(groupId);
  const target = createChatTarget(selfId, userId, groupId);

  if (runtimeState.isRateLimitBlocked()) return;

  try {
    const quoted = await getQuotedContent(e, ctx);
    const imageUrls: string[] = [];
    for (const seg of e.message) {
      const url = seg.type === "image" ? segUrl(seg) : undefined;
      if (url) imageUrls.push(url);
    }
    if (quoted?.imageUrl) imageUrls.push(quoted.imageUrl);

    // 引用图片的描述和拉历史并行
    const targetMessage = describeQuotedImage(
      pluginCtx,
      cfg,
      quoted?.imageUrl,
      target,
    ).then((imageNote) => buildTargetMessage(pluginCtx, e, quoted, imageNote));

    await runChatTurn(pluginCtx, {
      source: "message",
      target,
      cfg,
      event: e,
      targetMessage,
      pendingImageUrls: imageUrls,
    });
  } catch (err) {
    ctx.logger.error(`Chat processing failed: ${err}`);
  }
}

function buildTargetMessage(
  pluginCtx: ChatPluginContext,
  e: MessageEvent,
  quoted: QuotedContent | null,
  imageNote: string | undefined,
): TargetMessage {
  const userId = eventUserId(e);
  let content = pluginCtx.ctx.text(e) || "";
  let quote: QuoteInfo | undefined;

  if (quoted) {
    quote = {
      messageId: String(quoted.messageId ?? ""),
      senderName: quoted.senderName || undefined,
      senderId: quoted.senderId || undefined,
      content: quoted.content || undefined,
      fromBot: quoted.fromBot,
    };
    const quotedText = quoted.content || (quoted.imageUrl ? "[图片]" : "");
    const who = quoted.senderName || quoted.senderId || "某人";
    const idPart = quoted.messageId ? ` #${quoted.messageId}` : "";
    const parts = [`[引用了 ${who} 的消息${idPart}：${quotedText}]`];
    if (quoted.imageUrl) {
      parts.push(
        imageNote
          ? `[引用消息里的图片：${imageNote}]`
          : "[引用消息里有一张图片]",
      );
    }
    content = `${parts.join(" ")} ${content}`;
  }

  return {
    userName: senderName(e, userId),
    userId,
    userRole: e.sender?.role || "member",
    userTitle: senderTitle(e.sender),
    content,
    messageId: e.message_id,
    timestamp: Date.now(),
    quote,
  };
}

/**
 * 主模型看不了图时，引用里的图片交给视觉模型描述（按内容哈希入库复用）。
 * 主模型能看图时图片直接附到请求里，返回 undefined。
 */
async function describeQuotedImage(
  pluginCtx: ChatPluginContext,
  cfg: ChatConfig,
  imageUrl: string | undefined,
  target: ChatTarget,
): Promise<string | undefined> {
  if (!imageUrl || mainModelSupportsVision(pluginCtx.aiService, cfg.model)) {
    return undefined;
  }
  const visionAI =
    pluginCtx.visionAIInstance ?? pluginCtx.aiService.getDefault();
  if (!visionAI) return undefined;

  try {
    const { processImage } = await import("../media/image-analyzer");
    const record = await processImage(
      visionAI,
      imageUrl,
      cfg.multimodalWorkingModel,
      pluginCtx.db,
      {
        runAIRequest: (request) =>
          pluginCtx.runWithRateLimitGuard(request, {
            userId: target.userId,
            groupId: target.groupId,
            label: "quoted-image",
            skipRetryOnRateLimit: true,
          }),
      },
    );
    return record?.description?.trim() || undefined;
  } catch (err) {
    pluginCtx.ctx.logger.error(
      `[chat-turn] Failed to describe quoted image: ${err}`,
    );
    return undefined;
  }
}
