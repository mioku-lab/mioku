import { type MiokiContext } from "mioki";
import type { BootPluginConfig } from "../configs/base";

export function registerLikeCommand(
  ctx: MiokiContext,
  getConfig: () => BootPluginConfig,
): () => void {
  return ctx.handle(
    "message",
    async (event: any) => {
      const cfg = getConfig();
      const text = ctx.text(event)?.trim();
      if (!text || event?.user_id === event?.self_id) {
        return;
      }

      if (!cfg.likeCommand.enabled) {
        return;
      }

      const keyword = String(cfg.likeCommand.keyword || "").trim();
      if (!keyword || text !== keyword) {
        return;
      }

      const selfId = Number(event?.self_id || ctx.self_id);
      const userId = Number(event?.user_id || event?.sender?.user_id || 0);
      if (!userId) {
        return;
      }

      const bot = ctx.pickBot(selfId);
      const likeTimes = Math.max(
        1,
        Number(cfg.likeCommand.likeTimes) || 10,
      );
      const reactionEmojiId = Math.max(
        0,
        Number(cfg.likeCommand.reactionEmojiId) || 66,
      );
      const messageId = event?.message_id;

      try {
        await bot.sendLike(userId, likeTimes);
      } catch (error) {
        ctx.logger.warn(`boot sendLike 失败: ${error}`);
      }

      if (messageId == null) {
        return;
      }

      try {
        await bot.api("set_msg_emoji_like", {
          message_id: messageId,
          emoji_id: reactionEmojiId,
          set: true,
        });
      } catch (error) {
        ctx.logger.warn(`boot set_msg_emoji_like 失败: ${error}`);
      }
    },
    { deduplicate: false },
  );
}
