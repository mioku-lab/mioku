import type { ChatPluginContext } from "../context";

export function createGroupEventHandler(pluginCtx: ChatPluginContext) {
  const { ctx } = pluginCtx;

  const resolveName = (userId: unknown, fallback?: unknown): string => {
    const id = String(userId ?? "").trim();
    if (!id) return String(fallback ?? "").trim() || "某人";
    const known = pluginCtx.db.getMessagesByUser(id, undefined, 1);
    const name = known?.[0]?.userName?.trim();
    if (name && name !== id) return name;
    const fallbackText = String(fallback ?? "").trim();
    return fallbackText || id;
  };

  return async (e: any): Promise<void> => {
    try {
      const raw = e?.raw ?? e ?? {};
      const noticeType = String(e?.notice_type ?? raw.notice_type ?? "");
      const subType = String(e?.sub_type ?? raw.sub_type ?? "");
      // 适配器已归一化
      const kind =
        noticeType === "group" || noticeType === "notify"
          ? subType
          : noticeType.replace(/^group_/, "");
      const groupId = String(
        e?.group_id ?? raw.group_id ?? raw.group?.group_id ?? "",
      ).trim();
      if (!groupId) return;

      const selfId = String(e?.self_id ?? raw.self_id ?? "").trim();

      // ---------- 撤回 ----------
      if (kind === "recall") {
        const messageId = String(
          raw.message_id ?? raw.msg_id ?? e?.message_id ?? "",
        ).trim();
        if (!messageId) return;
        const operatorId = String(raw.operator_id ?? raw.user_id ?? "").trim();
        const authorId = String(raw.user_id ?? raw.author_id ?? "").trim();
        const cached = pluginCtx.groupEvents.lookupMessageContent(messageId);

        const recorded = pluginCtx.groupEvents.recordRecall({
          groupId,
          messageId,
          operatorId,
          operatorName: resolveName(operatorId),
          authorId,
          authorName: resolveName(authorId),
          cachedContent: cached,
          eventKey: `recall:${groupId}:${messageId}`,
        });
        if (recorded) {
          ctx.logger.debug(
            `[group-events] 记录撤回 group=${groupId} 原文=${cached ? "已还原" : "未留存"}`,
          );
        }
        return;
      }

      // ---------- 进退群 ----------
      if (kind === "increase" || kind === "decrease") {
        const userId = String(raw.user_id ?? e?.user_id ?? "").trim();
        if (!userId) return;
        const eventKind =
          kind === "increase" ? "member_increase" : "member_decrease";
        const recorded = pluginCtx.groupEvents.record({
          groupId,
          kind: eventKind,
          userId,
          userName: resolveName(userId, raw.nickname),
          eventKey: `${eventKind}:${groupId}:${userId}:${String(raw.time ?? e?.time ?? Date.now())}`,
        });
        if (recorded) {
          ctx.logger.debug(`[group-events] 记录${eventKind} group=${groupId}`);
        }
        return;
      }
      const pokeSegment = Array.isArray(e?.message)
        ? e.message.find((seg: any) => seg?.type === "poke")
        : undefined;
      if (kind === "poke" || pokeSegment) {
        const who = String(
          raw.user_id ?? e?.user_id ?? e?.sender?.user_id ?? "",
        ).trim();
        const target = String(
          raw.target_id ??
            pokeSegment?.data?.id ??
            pokeSegment?.data?.user_id ??
            pokeSegment?.id ??
            "",
        ).trim();
        if (!who && !target) return;

        const recorded = pluginCtx.groupEvents.record({
          groupId,
          kind: "poke",
          userId: who,
          userName: resolveName(who, raw.nickname ?? e?.sender?.nickname),
          targetId: target,
          targetName: resolveName(target),
          eventKey: `poke:${groupId}:${who}:${target}:${Math.floor(
            Number(raw.time ?? e?.time ?? Date.now() / 1000) || 0,
          )}`,
        });
        if (recorded) {
          ctx.logger.debug(
            `[group-events] 记录拍一拍 group=${groupId} ${who} -> ${target}${
              target && target === selfId ? "（戳的是机器人）" : ""
            }`,
          );
        }
        return;
      }
    } catch (err) {
      ctx.logger.warn(`[group-events] 采集失败: ${err}`);
    }
  };
}
