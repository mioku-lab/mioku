import { createGroupRef, type MiokuContext } from "mioku";
import type { BotRole } from "../types";

export interface GroupInfoResult {
  groupName: string | undefined;
  memberCount: number | undefined;
}

export function toBotRole(role: unknown): BotRole {
  return role === "owner" || role === "admin" ? role : "member";
}

/** 机器人在群里的身份，查不到按普通成员 */
export async function getBotRole(
  ctx: MiokuContext,
  groupId: string,
  selfId: string,
): Promise<BotRole> {
  try {
    const bot = ctx.pickBot(selfId);
    if (!bot) return "member";
    const memberInfo = await bot.getMemberInfo(groupId, selfId);
    return toBotRole(memberInfo?.role);
  } catch {
    return "member";
  }
}

export async function getGroupInfoData(
  ctx: MiokuContext,
  groupId: string,
  selfId: string,
  fallbackGroupName?: string,
): Promise<GroupInfoResult> {
  try {
    const bot = ctx.pickBot(selfId);
    if (!bot) return { groupName: fallbackGroupName, memberCount: undefined };
    const groupInfo = await createGroupRef(bot, String(groupId)).getInfo();
    if (!groupInfo) return { groupName: undefined, memberCount: undefined };
    return {
      groupName: groupInfo.group_name || fallbackGroupName,
      memberCount: groupInfo.member_count,
    };
  } catch {
    return { groupName: fallbackGroupName, memberCount: undefined };
  }
}
