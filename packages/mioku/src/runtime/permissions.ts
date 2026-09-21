import type { Event, MessageEvent } from "../adapter";
import {
  isAdmin as isConfiguredAdmin,
  isOwner as isConfiguredOwner,
} from "../config";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 从事件对象中提取发送者 id（支持裸 id / user_id / sender.user_id） */
export const toUserId = (value: unknown): string | undefined => {
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (isObject(value)) {
    if ("user_id" in value)
      return toUserId((value as { user_id: unknown }).user_id);
    if ("sender" in value) {
      const sender = (value as { sender: unknown }).sender;
      if (isObject(sender) && "user_id" in sender) {
        return toUserId((sender as { user_id: unknown }).user_id);
      }
    }
  }
  return undefined;
};

/** 提取群号（群消息时） */
const toGroupId = (event: Event): string | undefined => {
  if (!("group_id" in event) || event.group_id == null) return undefined;
  return String(event.group_id);
};

/** 是否群消息 */
const isGroupMessage = (event: unknown): event is MessageEvent =>
  isObject(event) &&
  (event as { kind?: unknown }).kind === "message" &&
  (event as { message_type?: unknown }).message_type === "group";

/** 当前群群主（仅限所在群） */
export const isEventGroupOwner = (event: unknown): boolean => {
  if (!isGroupMessage(event)) return false;
  return event.sender?.role === "owner";
};

/** 当前群群主或群管理员（仅限所在群） */
export const isEventGroupAdmin = (event: unknown): boolean => {
  if (!isGroupMessage(event)) return false;
  const role = event.sender?.role;
  return role === "owner" || role === "admin";
};

/** 仅看 owners 名单：bot 主人（无群身份加成） */
export const isEventMaster = (event: unknown): boolean => {
  const id = toUserId(event);
  if (!id) return false;
  return isConfiguredOwner(id);
};

/** 仅看 admins 名单：配置管理员 */
export const isEventAdminConfigOnly = (event: unknown): boolean => {
  const id = toUserId(event);
  if (!id) return false;
  return isConfiguredAdmin(id);
};

/**
 * master 或当前群群主
 */
export const isEventOwner = (event: unknown): boolean =>
  isEventMaster(event) || isEventGroupOwner(event);

/**
 * master、配置管理员、当前群群主或群管理员
 */
export const isEventAdmin = (event: unknown): boolean =>
  isEventOwner(event) ||
  isEventAdminConfigOnly(event) ||
  isEventGroupAdmin(event);

export const isEventOwnerOrAdmin = (event: unknown): boolean =>
  isEventAdmin(event);
export const hasEventRight = (event: unknown): boolean =>
  isEventOwnerOrAdmin(event);

// 避免 lint 把 toGroupId 当作未使用导出
export const __test_groupIdProbe = toGroupId;
