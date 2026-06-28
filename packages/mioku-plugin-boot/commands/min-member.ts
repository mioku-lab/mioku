import { type MiokiContext, wait } from "mioki";
import type { BootPluginConfig } from "../configs/base";
import { isPrivilegedUser } from "../filter/access-rules";

export function registerMinMemberCheck(
  ctx: MiokiContext,
  getConfig: () => BootPluginConfig,
): () => void {
  return ctx.handle("notice.group.increase" as any, async (event: any) => {
    const cfg = getConfig();
    const selfId = Number(event?.self_id || ctx.self_id);
    const groupId = Number(event?.group_id || 0);
    const userId = Number(event?.user_id || 0);
    if (!groupId || !userId) return;
    if (userId !== selfId) return;

    if (
      event?.action_type === "invite" &&
      isPrivilegedUser(event?.operator_id)
    ) {
      ctx.logger.info(`群 ${groupId} 由主人/管理员邀请加入，跳过入群限制检查`);
      return;
    }

    const minMemberCount = Math.max(0, Number(cfg.group.minMemberCount) || 0);
    if (minMemberCount <= 0) return;

    const bot = ctx.pickBot(selfId);
    if (!bot) return;

    try {
      await wait(1000);
      const groupInfo = await bot.getGroupInfo(groupId);
      const memberCount = Number(groupInfo?.member_count || 0);
      if (memberCount > 0 && memberCount < minMemberCount) {
        await bot.api("set_group_leave", {
          group_id: groupId,
          is_dismiss: false,
        });
        ctx.logger.info(
          `群 ${groupId} 人数 ${memberCount} 低于限制 ${minMemberCount}，已自动退群`,
        );
      }
    } catch (error) {
      ctx.logger.warn(`入群人数检查失败: ${error}`);
    }
  });
}
