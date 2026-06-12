import { botConfig } from "mioki";
import type {
  AccessAction,
  AccessControlConfig,
  AccessRuleEntry,
  AccessScopeConfig,
} from "mioku";

export function isPrivilegedUser(userId: string | number | undefined): boolean {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) return false;
  const owners = Array.isArray(botConfig?.owners) ? botConfig.owners : [];
  const admins = Array.isArray(botConfig?.admins) ? botConfig.admins : [];
  return [...owners, ...admins].some(
    (value) => String(value).trim() === normalizedUserId,
  );
}

function resolveActorId(event: any, eventName: string): string | null {
  const s = String(eventName || "");
  if (s.startsWith("notice.")) {
    if (event?.operator_id != null) return String(event.operator_id);
    if (event?.user_id != null) return String(event.user_id);
    if (event?.sender?.user_id != null) return String(event.sender.user_id);
    return null;
  }
  if (event?.user_id != null) return String(event.user_id);
  if (event?.sender?.user_id != null) return String(event.sender.user_id);
  if (event?.operator_id != null) return String(event.operator_id);
  return null;
}

function shouldBypassForPrivilegedActor(
  eventName: string,
  actorId: string | null,
): boolean {
  if (!actorId) return false;
  const s = String(eventName || "");
  if (!s.startsWith("request.") && !s.startsWith("notice.")) return false;
  return isPrivilegedUser(actorId);
}

function lookupInScope(
  scope: AccessScopeConfig | undefined,
  plugin: string,
  command: string | null,
): AccessRuleEntry | undefined {
  if (!scope) return undefined;
  if (command) {
    const cmdRule = scope.commands?.[plugin]?.[command];
    if (cmdRule) return cmdRule;
  }
  return scope.plugins?.[plugin];
}

export function resolveAccessForCandidates(
  rules: AccessControlConfig,
  event: any,
  eventName: string,
  candidates: Array<{ plugin: string; command: string | null }>,
): AccessAction {
  const actorId = resolveActorId(event, eventName);
  if (shouldBypassForPrivilegedActor(eventName, actorId)) {
    return "allow";
  }

  const userId = event?.user_id != null ? String(event.user_id) : null;
  const groupId =
    event?.message_type === "group" && event?.group_id != null
      ? String(event.group_id)
      : event?.group_id != null
        ? String(event.group_id)
        : null;

  const userScope = userId ? rules.users?.[userId] : undefined;
  const groupScope = groupId ? rules.groups?.[groupId] : undefined;
  const globalScope = rules.global;

  for (const cand of candidates) {
    // 顺序即优先级: user > group > global; command > plugin。
    for (const scope of [userScope, groupScope, globalScope]) {
      const rule = lookupInScope(scope, cand.plugin, cand.command);
      if (rule) return rule.action;
    }
  }
  return "allow";
}
