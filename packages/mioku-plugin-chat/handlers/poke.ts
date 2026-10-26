import type { NoticeEvent } from "mioku";
import type { ChatPluginContext, ChatHandlerState } from "../context";
import type { TargetMessage } from "../types";
import { isGroupAllowed } from "../utils/trigger";
import { readField } from "../utils/record";
import { createChatTarget } from "../core/turn/target";
import { runChatTurn } from "../core/turn/run-turn";
import { POKE_COOLDOWN_MS } from "./message";

export function createPokeHandler(
  pluginCtx: ChatPluginContext,
  state: ChatHandlerState,
) {
  const { ctx } = pluginCtx;
  const { getConfig, runtimeState, pokeCooldowns } = state;

  return async (e: NoticeEvent) => {
    const selfId = String(e.self_id ?? "").trim();
    const targetId = String(
      readField(e.raw, "target_id") ??
        readField(e.raw, "user_id") ??
        e.user_id ??
        "",
    ).trim();
    if (!targetId || targetId !== selfId) return;
    const groupId = String(e.group_id ?? "").trim();
    const cfg = groupId ? await getConfig(groupId) : await getConfig();
    if (!cfg.model && !cfg.apiKey) return;
    if (!groupId || !isGroupAllowed(groupId, cfg)) return;

    const lastPoke = pokeCooldowns.get(groupId) ?? 0;
    if (Date.now() - lastPoke < POKE_COOLDOWN_MS) return;
    pokeCooldowns.set(groupId, Date.now());

    const userId = String(e.user_id ?? "").trim();
    const target = createChatTarget(selfId, userId, groupId);
    if (runtimeState.isRateLimitBlocked()) return;

    try {
      await pluginCtx.sessionTurnScheduler.run(
        target.sessionId,
        "poke",
        async () => {
          const userName = await resolvePokerName(e, groupId, userId);
          const targetMessage: TargetMessage = {
            userName,
            userId,
            userRole: "member",
            content: `[${userName} 戳了你一下]`,
            timestamp: Date.now(),
          };
          await runChatTurn(pluginCtx, {
            source: "poke",
            target,
            cfg,
            event: e,
            targetMessage,
          });
        },
      );
    } catch (err) {
      ctx.logger.error(`Poke processing failed: ${err}`);
    }
  };
}

async function resolvePokerName(
  e: NoticeEvent,
  groupId: string,
  userId: string,
): Promise<string> {
  try {
    const memberInfo = await e.bot.getMemberInfo(groupId, userId);
    return memberInfo?.card || memberInfo?.nickname || userId;
  } catch {
    return userId;
  }
}
