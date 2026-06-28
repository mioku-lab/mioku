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
  admin: 3,
  owner: 2,
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
 * - `master` is honored everywhere (private or group) — it comes from
 *   mioki's `isOwner` allowlist.
 * - Private chat skips the `isAdmin` check and defaults to `admin`,
 *   so anyone DM-ing the bot can see admin-level commands.
 * - Group chat keeps the full hierarchy: admin (mioki allowlist) →
 *   owner (group owner via `getGroupMemberInfo`) → member.
 */
export async function resolveViewerRole(
  ctx: any,
  event: any,
): Promise<CommandRole> {
  if (ctx?.isOwner?.(event)) {
    return "master";
  }

  const isGroup = event?.message_type === "group";

  if (isGroup) {
    if (ctx?.isAdmin?.(event)) {
      return "admin";
    }

    if (event?.group_id != null && event?.user_id != null) {
      const selfId =
        event?.self_id != null ? Number(event.self_id) : undefined;
      const bot =
        selfId != null && typeof ctx?.pickBot === "function"
          ? ctx.pickBot(selfId)
          : undefined;
      if (bot && typeof bot.getGroupMemberInfo === "function") {
        try {
          const info = await bot.getGroupMemberInfo(
            event.group_id,
            event.user_id,
          );
          if (info?.role === "owner") {
            return "owner";
          }
        } catch {
          // fall through to member
        }
      }
    }

    return "member";
  }

  return "admin";
}
