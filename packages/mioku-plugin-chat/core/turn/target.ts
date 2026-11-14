import type { ChatTarget } from "../../types";

export function createChatTarget(
  selfId: string,
  userId: string,
  groupId?: string,
): ChatTarget {
  return {
    selfId,
    groupId,
    userId,
    sessionId: groupId ? `group:${groupId}` : `personal:${userId}`,
  };
}
