import type { MessageEvent, MiokuContext } from "mioku";
import type { ChatConfig, ChatMessage } from "../types";
import { eventUserId, senderName, senderTitle } from "./sender";

/** 命中的昵称；是否真在叫它由工作模型判断 */
export function hasNicknameHit(
  text: string,
  nicknames: string[],
): string | undefined {
  const raw = String(text || "").toLowerCase();
  if (!raw) return undefined;

  for (const nickname of nicknames) {
    const needle = String(nickname || "").trim();
    if (needle && raw.includes(needle.toLowerCase())) return needle;
  }
  return undefined;
}

export function detectTriggerSource(
  ctx: MiokuContext,
  e: MessageEvent,
  text: string,
  cfg: ChatConfig,
): { atBot: boolean; nicknameHit?: string } {
  if (e.message_type === "private") return { atBot: false };
  const atBot = ctx.mentionedBots(e).length > 0;
  const nicknameHit = hasNicknameHit(text, cfg.nicknames || []);
  return { atBot, nicknameHit };
}

export function isGroupAllowed(groupId: string, cfg: ChatConfig): boolean {
  if (cfg.whitelistGroups.length > 0) {
    return cfg.whitelistGroups.includes(groupId);
  }
  if (cfg.blacklistGroups.length > 0) {
    return !cfg.blacklistGroups.includes(groupId);
  }
  return true;
}

export function buildChatMessageFromEvent(
  e: MessageEvent,
  text: string,
  groupId: string | undefined,
): ChatMessage {
  const userId = eventUserId(e);
  return {
    sessionId: groupId ? `group:${groupId}` : `personal:${userId}`,
    role: "user",
    content: text,
    userId,
    userName: senderName(e, userId),
    userRole: e.sender?.role || "member",
    userTitle: senderTitle(e.sender),
    groupId,
    groupName: groupId ? e.group_name : undefined,
    timestamp: Date.now(),
    messageId: e.message_id,
  };
}
