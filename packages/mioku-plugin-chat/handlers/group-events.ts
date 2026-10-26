import type { NoticeEvent } from "mioku";
import type { ChatPluginContext } from "../context";
import { readField } from "../utils/record";
import { segData, segTop } from "../utils/segment";

/** 依次取第一个非 null 字段，统一转成去空白的字符串 */
function firstId(...values: unknown[]): string {
  return String(values.find((v) => v != null) ?? "").trim();
}

export function createGroupEventHandler(pluginCtx: ChatPluginContext) {
  const { ctx } = pluginCtx;

  const resolveName = (userId: string, fallback?: unknown): string => {
    const fallbackText = String(fallback ?? "").trim();
    if (!userId) return fallbackText || "某人";
    const known = pluginCtx.db.getMessagesByUser(userId, undefined, 1);
    const name = known[0]?.userName?.trim();
    if (name && name !== userId) return name;
    return fallbackText || userId;
  };

  return async (e: NoticeEvent): Promise<void> => {
    try {
      const raw = e.raw ?? e;
      const field = (key: string) => readField(raw, key);
      const noticeType = String(e.notice_type ?? field("notice_type") ?? "");
      const subType = String(e.sub_type ?? field("sub_type") ?? "");
      // 适配器已归一化
      const kind =
        noticeType === "group" || noticeType === "notify"
          ? subType
          : noticeType.replace(/^group_/, "");
      const groupId = firstId(
        e.group_id,
        field("group_id"),
        readField(field("group"), "group_id"),
      );
      if (!groupId) return;

      const selfId = firstId(e.self_id, field("self_id"));
      const eventTime = field("time") ?? e.time;

      if (kind === "recall") {
        const messageId = firstId(
          field("message_id"),
          field("msg_id"),
          readField(e, "message_id"),
        );
        if (!messageId) return;
        const operatorId = firstId(field("operator_id"), field("user_id"));
        const authorId = firstId(field("user_id"), field("author_id"));
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

      if (kind === "increase" || kind === "decrease") {
        const userId = firstId(field("user_id"), e.user_id);
        if (!userId) return;
        const eventKind =
          kind === "increase" ? "member_increase" : "member_decrease";
        const recorded = pluginCtx.groupEvents.record({
          groupId,
          kind: eventKind,
          userId,
          userName: resolveName(userId, field("nickname")),
          eventKey: `${eventKind}:${groupId}:${userId}:${String(eventTime ?? Date.now())}`,
        });
        if (recorded) {
          ctx.logger.debug(`[group-events] 记录${eventKind} group=${groupId}`);
        }
        return;
      }

      const message = readField(e, "message");
      const pokeSegment = Array.isArray(message)
        ? message.find((seg) => segTop(seg, "type") === "poke")
        : undefined;
      if (kind === "poke" || pokeSegment) {
        const sender = readField(e, "sender");
        const who = firstId(
          field("user_id"),
          e.user_id,
          readField(sender, "user_id"),
        );
        const target = String(
          field("target_id") ??
            segData(pokeSegment, "id") ??
            segData(pokeSegment, "user_id") ??
            segTop(pokeSegment, "id") ??
            "",
        ).trim();
        if (!who && !target) return;

        const recorded = pluginCtx.groupEvents.record({
          groupId,
          kind: "poke",
          userId: who,
          userName: resolveName(
            who,
            field("nickname") ?? readField(sender, "nickname"),
          ),
          targetId: target,
          targetName: resolveName(target),
          eventKey: `poke:${groupId}:${who}:${target}:${Math.floor(
            Number(eventTime ?? Date.now() / 1000) || 0,
          )}`,
        });
        if (recorded) {
          ctx.logger.debug(
            `[group-events] 记录拍一拍 group=${groupId} ${who} -> ${target}${
              target && target === selfId ? "（戳的是机器人）" : ""
            }`,
          );
        }
      }
    } catch (err) {
      ctx.logger.warn(`[group-events] 采集失败: ${err}`);
    }
  };
}
