import type { SenderInfo } from "mioku";
import type { ChatTurnEvent } from "../types";

/** 群头衔：框架的 SenderInfo 未声明，部分适配器会带上 */
export function senderTitle(sender: SenderInfo | undefined): string | undefined {
  if (!sender || !("title" in sender)) return undefined;
  const title = sender.title;
  return typeof title === "string" && title ? title : undefined;
}

/** 群名片 > 昵称 > 兜底 */
export function senderName(
  event: Pick<ChatTurnEvent, "sender"> | undefined,
  fallback: string,
): string {
  return event?.sender?.card || event?.sender?.nickname || fallback;
}

/** 事件里的发送者账号 */
export function eventUserId(
  event: Pick<ChatTurnEvent, "user_id" | "sender"> | undefined,
): string {
  return String(event?.user_id ?? event?.sender?.user_id ?? "").trim();
}
