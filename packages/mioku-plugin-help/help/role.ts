/**
 * Viewer role resolution for the help image.
 *
 * Decides which commands a given user is allowed to see based on the
 * event's sender and the bot's owner/admin allowlists. The result is
 * used to filter `getRenderableEntries` so the rendered help image
 * matches what the requester can actually invoke.
 */

import type { CommandRole } from "mioku";

const ROLE_RANK: Record<CommandRole, number> = {
  master: 4,
  owner: 3,
  admin: 2,
  member: 1,
};

/**
 * Whether the given viewer can invoke a command gated at `commandRole`.
 * A command without a `role` field is treated as member-level (visible
 * to everyone).
 */
export function canInvokeCommand(
  viewerRole: CommandRole,
  commandRole: CommandRole | undefined,
): boolean {
  const required: CommandRole = commandRole || "member";
  return ROLE_RANK[viewerRole] >= ROLE_RANK[required];
}

/**
 * Resolve the requesting user's effective role for help filtering.
 *
 * Mirrors the command manager's gating so the image hides exactly the
 * commands the viewer cannot run:
 *
 * - `ctx.isMaster` → `master` (bot `owners`).
 * - `ctx.isOwner` → `owner` (主人或当前群群主).
 * - `ctx.isAdmin` → `admin` (配置管理员或群管理).
 * - Otherwise, when the event carries no `sender.role`, fall back to
 *   `getMemberInfo`; an unresolved member counts as `member` — guessing
 *   upward would show commands the viewer cannot invoke.
 */
export async function resolveViewerRole(
  ctx: any,
  event: any,
): Promise<CommandRole> {
  if (ctx?.isMaster?.(event)) {
    return "master";
  }
  if (ctx?.isOwner?.(event)) {
    return "owner";
  }
  if (ctx?.isAdmin?.(event)) {
    return "admin";
  }

  const groupId = String(event?.group_id ?? "").trim();
  const userId = String(event?.user_id ?? "").trim();
  if (groupId && userId) {
    const bot = event?.bot;
    if (bot) {
      try {
        const info = await bot.getMemberInfo(groupId, userId);
        if (info?.role === "owner" || info?.role === "admin") {
          return info.role;
        }
      } catch {
        // 查询失败按普通成员处理
      }
    }
  }

  return "member";
}
