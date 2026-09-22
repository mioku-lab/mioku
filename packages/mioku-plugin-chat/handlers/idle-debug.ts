import type { MiokuContext } from "mioku";
import type { AIService } from "mioku";
import type { ChatPluginContext } from "../context";
import type { ChatConfig, TargetMessage } from "../types";
import { finalizeChatTurn } from "../core/chat-turn";
import { getBotRole } from "../utils";

export async function handleIdleCheckDebug(
  pluginCtx: ChatPluginContext,
  e: any,
  cfg: ChatConfig,
): Promise<void> {
  const ctx: MiokuContext = pluginCtx.ctx;
  const isOwner = ctx.isMaster?.(e) ?? false;
  if (!isOwner) {
    await e.reply("只有主人才能使用这个指令~");
    return;
  }
  const groupIdStr =
    e.message[0]?.text?.replace(".空闲检查", "")?.trim() || "";
  const targetGroupId = String(groupIdStr).trim();
  if (!targetGroupId) {
    await e.reply("请指定群 ID，如：.空闲检查 123456");
    return;
  }

  const groupSessionId = `group:${targetGroupId}`;
  try {
    await pluginCtx.sessionTurnScheduler.run(
      groupSessionId,
      "idle-debug",
      async () => {
        const now = Date.now();
        const botNickname =
          cfg.nicknames[0] || e.bot?.nickname || "Bot";
        ctx.logger.info(`[Debug] Manual idle check: group ${targetGroupId}`);

        const { history } = await pluginCtx.getGroupHistoryMessages(
          targetGroupId,
          groupSessionId,
          ctx,
          cfg.historyCount,
          pluginCtx.db,
          e.self_id,
          pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
        );
        const planResult = await pluginCtx.humanize.actionPlanner.plan(
          groupSessionId,
          botNickname,
          history,
          "[Check if you want to answer the call]",
          true,
        );

        if (planResult.action !== "reply") {
          await e.reply(
            `[空闲检测] 群 ${targetGroupId}\n决定: ${planResult.action}\n原因: ${planResult.reason}`,
          );
          return;
        }

        const targetMessage: TargetMessage = {
          userName: "系统",
          userId: "",
          userRole: "member",
          content: "[No one in the group is talking? I'll answer!]",
          messageId: "",
          timestamp: now,
        };
        const botRole = await getBotRole(targetGroupId, ctx, e.self_id);
        const toolCtx = pluginCtx.buildToolContext({
          ctx,
          event: null,
          groupSessionId,
          groupId: targetGroupId,
          userId: "",
          config: cfg,
          aiService: ctx.services!.ai as AIService,
          db: pluginCtx.db,
          botRole,
          humanize: pluginCtx.humanize,
          targetMessage,
          selfId: e.self_id,
          audioService: pluginCtx.audioService,
        });

        const result = await pluginCtx.runWithRateLimitGuard(
          () =>
            pluginCtx.runChat(
              pluginCtx.aiInstance,
              toolCtx,
              history,
              targetMessage,
              {
                config: cfg,
                botNickname,
                botRole: toolCtx.botRole,
                aiService: ctx.services!.ai as AIService,
                isGroup: true,
                plannerThoughts:
                  'You stumbled upon some message in this group and decided to reply.\nQuote messages from group friends appropriately (using [reply:message ID] format).\nDon\'t mention your intentions like "I\'m here to answer".',
                replyContext: { type: "idle" },
              },
              pluginCtx.humanize,
              pluginCtx.skillManager,
            ),
          { groupId: targetGroupId, label: "idle-check", skipRetryOnRateLimit: true },
        );
        if (!result) {
          await e.reply(`[空闲检测] 群 ${targetGroupId} 因限流被跳过`);
          return;
        }

        await finalizeChatTurn(pluginCtx, {
          event: null,
          cfg,
          result,
          groupId: targetGroupId,
          groupSessionId,
          userId: "",
          selfId: String(e.self_id ?? "").trim(),
          toolCtx,
          send: true,
          isLive: true,
        });
        await e.reply(
          `[空闲检测] 群 ${targetGroupId} 已发送回复: ${planResult.reason}`,
        );
      },
    );
  } catch (err) {
    ctx.logger.error(`[Debug] Idle check failed: ${err}`);
    await e.reply(`[空闲检测] 失败: ${err}`);
  }
}
