import type { MessageEvent } from "mioku";
import type { ChatPluginContext, ChatHandlerState } from "../context";
import type { ChatConfig } from "../types";
import {
  buildChatMessageFromEvent,
  detectTriggerSource,
  isGroupAllowed,
} from "../utils/trigger";
import { isQuotingBot } from "../utils/quote";
import { toOptionalId } from "../utils/record";
import { eventUserId, senderName } from "../utils/sender";
import {
  createMediaProcessingOptions,
  getCardData,
  getForwardId,
  getSegmentUrl,
  getVideoSourceCandidatesFromMessage,
  isMediaAnalysisBlocked,
} from "../core/media/segment";
import {
  getSegmentSourceCandidates,
  summarizeHistoryCard,
  summarizeHistoryForward,
  summarizeHistoryVideo,
} from "../core/media/history-media";
import {
  buildStructuredUserMessages,
  structuredInputOf,
} from "../manage/group-structured-history";
import { processChat } from "../core/turn/live-message";
import { decideReplyGate, REPLY_GATE_HISTORY_COUNT } from "../core/reply-gate";

export const POKE_COOLDOWN_MS = 10 * 60_000;

const CARD_SEGMENT_TYPES = new Set(["xml", "json", "lightapp", "ark"]);

export function createMessageHandler(
  pluginCtx: ChatPluginContext,
  state: ChatHandlerState,
) {
  const { ctx } = pluginCtx;
  const { getConfig, matchMessageCommands, runtimeState } = state;

  return async (e: MessageEvent) => {
    const isGroup = e.message_type === "group";
    const groupId = isGroup ? toOptionalId(e.group_id) : undefined;
    const cfg = await getConfig(groupId);
    if (!isGroup && cfg.ignorePrivateChat) return;
    if (!cfg.model && !cfg.apiKey) return;
    if (!e?.message || !Array.isArray(e.message)) return;

    const text = ctx.text(e) || "";
    const userId = eventUserId(e);

    if (!userId || userId === String(e.self_id ?? "").trim()) return;
    if (matchMessageCommands && matchMessageCommands(text).length > 0) return;
    if (groupId && !isGroupAllowed(groupId, cfg)) return;

    if (groupId) {
      if (!isMediaAnalysisBlocked(cfg, userId)) {
        await analyzeMessageMedia(pluginCtx, e, cfg, groupId, userId);
      }
      recordForLearning(pluginCtx, e, cfg, groupId, text);
    }

    const { atBot, nicknameHit } = detectTriggerSource(ctx, e, text, cfg);
    const replyBot = ctx.pickReplyBot(e);
    const actorSelfId = String(replyBot?.bot_id ?? e.self_id ?? "").trim();

    const quotedBot = groupId ? await isQuotingBot(e, ctx) : null;
    const weakTrigger = Boolean(nicknameHit) || Boolean(quotedBot);
    const directedAtBot = atBot || weakTrigger;

    if (!groupId) {
      const triggerKey = `personal:${userId}`;
      const { processingSet } = runtimeState;
      if (processingSet.has(triggerKey)) return;
      processingSet.add(triggerKey);
      try {
        await processChat(pluginCtx, e, runtimeState, replyBot);
      } finally {
        processingSet.delete(triggerKey);
      }
      return;
    }

    const groupSessionId = `group:${groupId}`;
    if (pluginCtx.cooldownManager.isInCooldown(groupSessionId)) {
      pluginCtx.cooldownManager.collectMessage(
        groupSessionId,
        e,
        text,
        directedAtBot,
      );
      return;
    }

    if (!directedAtBot) return;

    if (weakTrigger && !atBot) {
      const decision = await decideReplyGate(
        pluginCtx.getAIInstance("working"),
        ctx.logger,
        {
          cfg,
          botNickname:
            cfg.nicknames[0] || replyBot?.nickname || e.bot?.nickname || "Bot",
          nickname: nicknameHit,
          quotedBot: Boolean(quotedBot),
          senderName: senderName(e, userId),
          text,
          messageId: e.message_id,
          history: pluginCtx.db.getMessages(
            groupSessionId,
            REPLY_GATE_HISTORY_COUNT,
          ),
        },
      );
      if (!decision.reply) return;
    }

    const runTriggeredMessage = async (): Promise<void> => {
      const { rateLimiter } = pluginCtx;
      if (atBot && !rateLimiter.canProcess(userId, groupId, text)) return;

      if (cfg.dynamicDelay?.enabled) {
        rateLimiter.recordInteraction(groupId, userId);
        const delayInfo = rateLimiter.getDelayInfo(groupId);
        if (delayInfo.shouldDelay) {
          rateLimiter.record(userId, groupId, text);
          pluginCtx.queueProcessor.collectDynamicDelayMessage(
            groupSessionId,
            e,
            text,
          );
          pluginCtx.queueProcessor.startDynamicDelayTimer(
            groupSessionId,
            groupId,
            delayInfo.delayMs,
            actorSelfId,
          );
          return;
        }
      }

      rateLimiter.record(userId, groupId, text);
      await processChat(pluginCtx, e, runtimeState, replyBot);
    };

    if (pluginCtx.sessionTurnScheduler.isBusy(groupSessionId)) {
      if (!runtimeState.isRateLimitBlocked()) {
        pluginCtx.queueManager.enqueue(groupSessionId, e, cfg);
        pluginCtx.rateLimiter.recordInteraction(groupId, userId);
        pluginCtx.queueProcessor.scheduleQueuedMessages(
          groupSessionId,
          actorSelfId,
        );
      }
      return;
    }

    await pluginCtx.sessionTurnScheduler.run(
      groupSessionId,
      "message",
      runTriggeredMessage,
    );
  };
}

/** 群消息里的图片、视频、转发、卡片在后台识别并缓存摘要 */
async function analyzeMessageMedia(
  pluginCtx: ChatPluginContext,
  e: MessageEvent,
  cfg: ChatConfig,
  groupId: string,
  userId: string,
): Promise<void> {
  const { ctx, db } = pluginCtx;
  const visionAI =
    pluginCtx.visionAIInstance ?? pluginCtx.aiService.getDefault();
  if (!visionAI) return;

  const runAIRequest = (label: string) =>
    <T>(request: () => Promise<T>) =>
      pluginCtx.runWithRateLimitGuard(request, {
        userId,
        groupId,
        label,
        skipRetryOnRateLimit: true,
      });
  const mediaOptions = createMediaProcessingOptions(visionAI, cfg, {
    db,
    bot: e.bot,
    groupId,
    logger: ctx.logger,
    runAIRequest: runAIRequest("history-media"),
  });
  const logFailure = (kind: string) => (err: unknown) =>
    ctx.logger.error(`[history-media] Failed to process ${kind}: ${err}`);

  if (cfg.enableMediaRecognition) {
    const { processImage } = await import("../core/media/image-analyzer");
    for (const seg of e.message) {
      if (seg.type === "image") {
        const imageUrl = getSegmentUrl(seg);
        if (!imageUrl) continue;
        processImage(visionAI, imageUrl, cfg.multimodalWorkingModel, db, {
          runAIRequest: runAIRequest("image-analysis"),
        }).catch((err) => ctx.logger.error(`[image-analyzer] Failed: ${err}`));
      } else if (seg.type === "video") {
        const videoSources = [
          ...getSegmentSourceCandidates(seg),
          ...(await getVideoSourceCandidatesFromMessage(
            e.bot,
            e.message_id,
          ).catch(() => [])),
        ];
        if (videoSources.length > 0) {
          summarizeHistoryVideo(videoSources, mediaOptions).catch(
            logFailure("video"),
          );
        }
      }
    }
  }

  for (const seg of e.message) {
    if (seg.type === "forward") {
      const forwardId = getForwardId(seg);
      if (forwardId) {
        summarizeHistoryForward(forwardId, mediaOptions).catch(
          logFailure("forward"),
        );
      }
    } else if (CARD_SEGMENT_TYPES.has(seg.type)) {
      const cardData = getCardData(seg);
      if (cardData) {
        summarizeHistoryCard(cardData, mediaOptions).catch(logFailure("card"));
      }
    }
  }
}

/** 所有群消息都入库，供话题、风格样本与结构化历史使用 */
function recordForLearning(
  pluginCtx: ChatPluginContext,
  e: MessageEvent,
  cfg: ChatConfig,
  groupId: string,
  text: string,
): void {
  const { ctx, db, humanize } = pluginCtx;
  const sessionId = `group:${groupId}`;
  const msg = buildChatMessageFromEvent(e, text, groupId);
  const hasText = Boolean(msg.content?.trim());
  const hasMultimodal = cfg.isMultimodal && Boolean(cfg.multimodalWorkingModel);

  if (!hasText && !hasMultimodal) {
    humanize.topicTracker
      .onMessage(sessionId)
      .catch((err) => ctx.logger.error(`[topic] window advance failed: ${err}`));
    return;
  }

  const record = async () => {
    db.saveMessage(msg);
    await humanize.topicTracker.onMessage(sessionId);
    pluginCtx.groupStructuredHistory.append(
      sessionId,
      buildStructuredUserMessages([structuredInputOf(msg)]),
      pluginCtx.configProvider(groupId).groupStructuredHistoryTtlMs,
    );
  };
  record().catch((err) =>
    ctx.logger.error(`[learning] always-on record failed: ${err}`),
  );
}
