import type { MiokuContext } from "../../../runtime/mioku-context";
import { replyText } from "./notify";
import {
  formatUptime,
  triggerRestart,
  type RestartMarker,
} from "../system/restart";

export function registerRestartCommand(ctx: MiokuContext): () => void {
  const dispose = ctx.command({
    name: "restart",
    aliases: ["重启"],
    permission: "master",
    priority: -1000,
    description: "重启机器人进程",
    handler: async ({ event }) => {
      if (String(event?.user_id ?? "") === String(event?.self_id ?? "")) return;

    const uptimeMs = process.uptime() * 1000;
    const selfId = String(event?.self_id ?? "");
    const groupId =
      event?.message_type === "group" && event?.group_id
        ? String(event.group_id)
        : null;
    const userId = String(event?.user_id ?? "");

    const marker: RestartMarker = {
      initiatedAt: Date.now(),
      selfId,
      groupId,
      userId,
      adapter: event?.bot?.adapter,
    };

    try {
      await replyText(event, `Bot已运行${formatUptime(uptimeMs)}，正在重启...`);
    } catch (error) {
      ctx.logger.warn(`[core] 发送重启提示失败: ${error}`);
    }

    ctx.logger.info(`[core] 正在执行重启命令 ${formatUptime(uptimeMs)}`);
    triggerRestart(marker);
    },
  });

  return dispose;
}
