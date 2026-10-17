import type { ChatPluginContext, ChatHandlerState } from "../context";
import type { TargetMessage } from "../types";
import type { Bot, NoticeEvent } from "mioku";

import { getBotRole, isGroupAllowed } from "../utils";
import { buildStructuredUserInputFromTarget } from "../manage/group-structured-history";
import { finalizeChatTurn } from "../core/chat-turn";
import { POKE_COOLDOWN_MS } from "./message";

export function createPokeHandler(
  pluginCtx: ChatPluginContext,
  state: ChatHandlerState,
) {
  const { ctx } = pluginCtx;
  const { getConfig, runtimeState, pokeCooldowns } = state;

  return async (e: NoticeEvent) => {
    const selfId = String(e.self_id ?? "").trim();
    const raw = e.raw as { target_id?: unknown; user_id?: unknown } | undefined;
    const targetId = String(
      raw?.target_id ?? raw?.user_id ?? e.user_id ?? "",
    ).trim();
    if (!targetId || targetId !== selfId) return;
    const groupId = String(e.group_id ?? "").trim();
    const cfg = groupId ? await getConfig(groupId) : await getConfig();
    if (!cfg.model && !cfg.apiKey) return;
    if (!groupId || !isGroupAllowed(groupId, cfg)) return;

    const lastPoke = pokeCooldowns.get(groupId) ?? 0;
    if (Date.now() - lastPoke < POKE_COOLDOWN_MS) return;
    pokeCooldowns.set(groupId, Date.now());

    const groupSessionId = `group:${groupId}`;
    if (runtimeState.isRateLimitBlocked()) return;

    try {
      await pluginCtx.sessionTurnScheduler.run(
        groupSessionId,
        "poke",
        async () => {
          pluginCtx.sessionManager.getOrCreate(
            groupSessionId,
            "group",
            groupId,
          );
          const userId = String(e.user_id ?? "").trim();
          const botRole = await getBotRole(groupId, ctx, selfId);
          const botNickname = cfg.nicknames[0] || e.bot?.nickname || "Bot";

          let senderName = String(userId);
          try {
            const bot: Bot | undefined = e.bot;
            const memberInfo = bot
              ? await bot.getMemberInfo(groupId, userId)
              : undefined;
            senderName =
              memberInfo?.card || memberInfo?.nickname || String(userId);
          } catch {}

          const targetMessage: TargetMessage = {
            userName: senderName,
            userId,
            userRole: "member",
            content: `[${senderName} poked you]`,
            timestamp: Date.now(),
          };

          const { history } = await pluginCtx.getGroupHistoryMessages(
            groupId,
            groupSessionId,
            ctx,
            cfg.historyCount,
            pluginCtx.db,
            selfId,
            pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
          );
          const { groupName, memberCount } = await pluginCtx.getGroupInfoData(
            ctx,
            groupId,
            selfId,
          );

          const toolCtx = pluginCtx.buildToolContext({
            ctx,
            event: e,
            groupSessionId,
            groupId,
            userId,
            config: cfg,
            aiService: pluginCtx.aiService,
            db: pluginCtx.db,
            botRole,
            humanize: pluginCtx.humanize,
            targetMessage,
            selfId,
            audioService: pluginCtx.audioService,
          });

          const result = await pluginCtx.runWithRateLimitGuard(
            () =>
              pluginCtx.runChat(
                pluginCtx.aiInstance,
                toolCtx,
                history,
                targetMessage,
                {
                  config: cfg,
                  groupName,
                  memberCount,
                  botNickname,
                  botRole,
                  aiService: pluginCtx.aiService,
                  isGroup: true,
                  replyContext: {
                    type: "poked",
                    targetUser: targetMessage.userName,
                    targetMessage: targetMessage.content,
                  },
                },
                pluginCtx.humanize,
                pluginCtx.skillManager,
                {
                  manager: pluginCtx.groupStructuredHistory,
                  ttlMs: cfg.groupStructuredHistoryTtlMs,
                  currentUserInputs: [
                    buildStructuredUserInputFromTarget(targetMessage),
                  ],
                },
              ),
            { userId, groupId, label: "poke", skipRetryOnRateLimit: true },
          );
          if (!result) return;

          await finalizeChatTurn(pluginCtx, {
            event: e,
            cfg,
            result,
            groupId,
            groupSessionId,
            userId,
            selfId,
            toolCtx,
            send: true,
            isLive: true,
          });
        },
      );
    } catch (err) {
      ctx.logger.error(`Poke processing failed: ${err}`);
    }
  };
}
