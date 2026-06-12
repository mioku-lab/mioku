import { type MiokiContext } from "mioki";
import type { BootPluginConfig } from "../configs/base";
import { isPrivilegedUser } from "../filter/access-rules";

export function registerAutoApprove(
  ctx: MiokiContext,
  getConfig: () => BootPluginConfig,
): () => void {
  const offFriend = ctx.handle("request.friend", async (event: any) => {
    if (!getConfig().friend.autoApprove) {
      return;
    }

    try {
      await event.approve();
      ctx.logger.info(`已自动通过好友申请: ${event.user_id}`);
    } catch (error) {
      ctx.logger.warn(`自动通过好友申请失败: ${error}`);
    }
  });

  const offGroup = ctx.handle("request.group.invite" as any, async (event: any) => {
    if (!isPrivilegedUser(event?.user_id)) {
      return;
    }

    try {
      await event.approve();
      ctx.logger.info(`已自动通过主人/管理员拉群邀请: ${event.user_id}`);
    } catch (error) {
      ctx.logger.warn(`自动通过主人/管理员拉群邀请失败: ${error}`);
    }
  });

  return () => {
    offFriend();
    offGroup();
  };
}
