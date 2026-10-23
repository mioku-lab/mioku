import type { ChatPluginContext, ChatHandlerState } from "../context";
import type { MessageEvent } from "mioku";
import {
  isGroupAllowed,
  detectTriggerSource,
  buildChatMessageFromEvent,
} from "../utils";
import {
  buildHistoryMediaProcessingOptions,
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
import { processChat } from "../core/chat-turn";
import { decideReplyGate, REPLY_GATE_HISTORY_COUNT } from "../core/reply-gate";

const POKE_COOLDOWN_MS = 10 * 60_000;

export function createMessageHandler(
  pluginCtx: ChatPluginContext,
  state: ChatHandlerState,
) {
  const { ctx } = pluginCtx;
  const { getConfig, matchMessageCommands, runtimeState } = state;

  return async (e: MessageEvent) => {
    const isGroup = e.message_type === "group";
    const groupId: string | undefined = isGroup
      ? String(e.group_id ?? "").trim() || undefined
      : undefined;
    const cfg = await getConfig(groupId);
    if (!isGroup && cfg.ignorePrivateChat) return;
    if (!cfg.model && !cfg.apiKey) return;
    if (!e?.message || !Array.isArray(e.message)) return;

    const text = ctx.text(e) || "";
    const userId: string = String(e.user_id ?? e.sender?.user_id ?? "").trim();

    if (!userId || userId === String(e.self_id ?? "").trim()) return;

    if (matchMessageCommands && matchMessageCommands(text).length > 0) return;

    if (groupId && !isGroupAllowed(groupId, cfg)) return;

    // 媒体分析
    if (
      isGroup &&
      groupId &&
      e.message &&
      !isMediaAnalysisBlocked(cfg, userId)
    ) {
      const visionAI =
        pluginCtx.visionAIInstance ?? pluginCtx.aiService.getDefault();
      const bot = e.bot;
      const mediaOptions = visionAI
        ? buildHistoryMediaProcessingOptions(
            visionAI,
            cfg,
            pluginCtx.db,
            bot,
            groupId,
            {
              info: (m) => ctx.logger.info(m),
              warn: (m) => ctx.logger.warn(m),
              error: (m) => ctx.logger.error(m),
            },
            (request) =>
              pluginCtx.runWithRateLimitGuard(request, {
                userId,
                groupId,
                label: "history-media",
                skipRetryOnRateLimit: true,
              }),
          )
        : undefined;

      if (visionAI && cfg.enableMediaRecognition) {
        const { processImage } = await import("../core/media/image-analyzer");
        for (const seg of e.message) {
          if (seg.type === "image") {
            const imageUrl = getSegmentUrl(seg);
            if (imageUrl) {
              processImage(
                visionAI,
                imageUrl,
                cfg.multimodalWorkingModel,
                pluginCtx.db,
                {
                  runAIRequest: (request) =>
                    pluginCtx.runWithRateLimitGuard(request, {
                      userId,
                      groupId,
                      label: "image-analysis",
                      skipRetryOnRateLimit: true,
                    }),
                },
              ).catch((err) =>
                ctx.logger.error(`[image-analyzer] Failed: ${err}`),
              );
            }
          } else if (seg.type === "video" && mediaOptions) {
            const videoSources = [
              ...getSegmentSourceCandidates(seg),
              ...(await getVideoSourceCandidatesFromMessage(
                bot,
                e.message_id,
              ).catch(() => [])),
            ];
            if (videoSources.length > 0) {
              summarizeHistoryVideo(videoSources, mediaOptions).catch((err) =>
                ctx.logger.error(
                  `[history-media] Failed to process video: ${err}`,
                ),
              );
            }
          }
        }
      }

      if (mediaOptions) {
        for (const seg of e.message) {
          if (seg.type === "forward") {
            const forwardId = getForwardId(seg);
            if (forwardId) {
              summarizeHistoryForward(forwardId, mediaOptions).catch((err) =>
                ctx.logger.error(
                  `[history-media] Failed to process forward: ${err}`,
                ),
              );
            }
          } else if (["xml", "json", "lightapp", "ark"].includes(seg.type)) {
            const cardData = getCardData(seg);
            if (cardData) {
              summarizeHistoryCard(cardData, mediaOptions).catch((err) =>
                ctx.logger.error(
                  `[history-media] Failed to process card: ${err}`,
                ),
              );
            }
          }
        }
      }
    }

    if (isGroup && groupId) {
      const learnSessionId = `group:${groupId}`;
      const learnMsg = buildChatMessageFromEvent(e, text, true, groupId);
      const hasText = !!learnMsg.content?.trim();
      const hasMultimodal = !!cfg.isMultimodal && !!cfg.multimodalWorkingModel;
      if (hasText || hasMultimodal) {
        pluginCtx
          .recordGroupMessageForLearning(learnMsg, learnSessionId)
          .catch((err) =>
            ctx.logger.error(`[learning] always-on record failed: ${err}`),
          );
      } else {
        pluginCtx.humanize.topicTracker
          .onMessage(learnSessionId)
          .catch((err) =>
            ctx.logger.error(`[topic] window advance failed: ${err}`),
          );
      }
    }

    const { atBot, nicknameHit } = detectTriggerSource(e, text, cfg, ctx);
    const replyBot = ctx.pickReplyBot(e);
    const actorSelfId = String(replyBot?.bot_id ?? e.self_id ?? "").trim();

    const quotedBot = isGroup ? await pluginCtx.isQuotingBot(e, ctx) : null;
    const weakTrigger = Boolean(nicknameHit) || Boolean(quotedBot);
    const directedAtBot = atBot || weakTrigger;

    const groupSessionId = groupId ? `group:${groupId}` : undefined;

    if (isGroup && groupId && groupSessionId) {
      if (pluginCtx.cooldownManager.isInCooldown(groupSessionId)) {
        pluginCtx.cooldownManager.collectMessage(
          groupSessionId,
          groupId,
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
              cfg.nicknames[0] ||
              replyBot?.nickname ||
              e.bot?.nickname ||
              "Bot",
            nickname: nicknameHit,
            quotedBot: Boolean(quotedBot),
            senderName: e.sender?.card || e.sender?.nickname || userId,
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
        if (atBot && !pluginCtx.rateLimiter.canProcess(userId, groupId, text))
          return;

        if (isGroup && groupId && groupSessionId && cfg.dynamicDelay?.enabled) {
          pluginCtx.rateLimiter.recordInteraction(groupId, userId);
          const delayInfo = pluginCtx.rateLimiter.getDelayInfo(groupId);
          if (delayInfo.shouldDelay) {
            pluginCtx.rateLimiter.record(userId, groupId, text);
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

        pluginCtx.rateLimiter.record(userId, groupId, text);
        await processChat(e, pluginCtx, runtimeState, { replyBot });
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
      return;
    }

    const triggerKey = `personal:${userId}`;
    const processingSet = runtimeState.processingSet;
    if (processingSet.has(triggerKey)) return;
    processingSet.add(triggerKey);
    try {
      await processChat(e, pluginCtx, runtimeState, { replyBot });
    } finally {
      processingSet.delete(triggerKey);
    }
  };
}

// re-exported so poke handler can share the constant if needed
export { POKE_COOLDOWN_MS };
