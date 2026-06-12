import { type MiokiContext, wait } from "mioki";
import type { AIService } from "mioku";
import type { BootPluginConfig } from "../configs/base";
import { isPrivilegedUser } from "../filter/access-rules";

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let output = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{${key}}`).join(value);
  }
  return output;
}

function normalizeGeneratedText(value: string): string {
  return String(value || "")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveMemberName(
  ctx: MiokiContext,
  groupId: number,
  userId: number,
  selfId: number,
): Promise<string> {
  try {
    const member = await ctx
      .pickBot(selfId)
      .getGroupMemberInfo(groupId, userId);
    return (
      String(member?.card || "").trim() ||
      String(member?.nickname || "").trim() ||
      String(userId)
    );
  } catch {
    return String(userId);
  }
}

export async function buildWelcomeMessage(options: {
  ctx: MiokiContext;
  aiService?: AIService;
  config: BootPluginConfig;
  groupId: number;
  groupName: string;
  userId: number;
  selfId: number;
}): Promise<string> {
  const { ctx, aiService, config, groupId, groupName, userId, selfId } = options;
  const memberName = await resolveMemberName(ctx, groupId, userId, selfId);
  const fallbackText =
    normalizeGeneratedText(
      renderTemplate(config.group.welcome.text, {
        user: memberName,
        group: groupName,
      }),
    ) || `欢迎新人～`;

  if (config.group.welcome.mode !== "ai") {
    return fallbackText;
  }

  const chatRuntime = aiService?.getChatRuntime();
  if (!chatRuntime) {
    return fallbackText;
  }

  try {
    await chatRuntime.generateNotice({
      selfId,
      groupId,
      send: true,
      instruction: [
        "当前有新成员入群，请发送一句欢迎语",
        `新成员：${memberName}`,
        `${config.group.welcome.aiPrompt || ""}`,
      ].join("\n"),
    });

    return "";
  } catch (error) {
    ctx.logger.error(`boot welcome chat-runtime 生成失败: ${error}`);
    return fallbackText;
  }
}

export function registerWelcomeHandler(
  ctx: MiokiContext,
  aiService: AIService | undefined,
  getConfig: () => BootPluginConfig,
): () => void {
  return ctx.handle("notice.group.increase" as any, async (event: any) => {
    const cfg = getConfig();
    const selfId = Number(event?.self_id || ctx.self_id);
    const groupId = Number(event?.group_id || 0);
    const userId = Number(event?.user_id || 0);
    if (!groupId || !userId) {
      return;
    }

    const bot = ctx.pickBot(selfId);

    if (userId === selfId) {
      if (
        event?.action_type === "invite" &&
        isPrivilegedUser(event?.operator_id)
      ) {
        ctx.logger.info(
          `群 ${groupId} 由主人/管理员邀请加入，跳过入群限制检查`,
        );
        return;
      }

      const minMemberCount = Math.max(
        0,
        Number(cfg.group.minMemberCount) || 0,
      );
      if (minMemberCount <= 0) {
        return;
      }

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
      return;
    }

    if (!cfg.group.welcome.enabled) {
      return;
    }

    const groupName =
      String(event?.group?.group_name || "").trim() || String(groupId);
    const welcomeMessage = await buildWelcomeMessage({
      ctx,
      aiService,
      config: cfg,
      groupId,
      groupName,
      userId,
      selfId,
    });

    if (!welcomeMessage) {
      return;
    }

    try {
      await bot.sendGroupMsg(groupId, [ctx.segment.text(welcomeMessage)]);
    } catch (error) {
      ctx.logger.warn(`发送入群欢迎失败: ${error}`);
    }
  });
}
