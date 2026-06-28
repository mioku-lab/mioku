import { type MiokiContext, wait } from "mioki";
import {
  getPluginRuntimeState,
  type AIService,
} from "mioku";
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

interface PendingMember {
  userId: number;
  memberName: string;
}

interface BatchState {
  members: PendingMember[];
  timer: ReturnType<typeof setTimeout> | null;
  groupName: string;
}

const RUNTIME_KEY = "welcomeBatch";

function getBatchMap(): Map<string, BatchState> {
  const state = getPluginRuntimeState("boot");
  if (!state[RUNTIME_KEY]) {
    state[RUNTIME_KEY] = new Map<string, BatchState>();
  }
  return state[RUNTIME_KEY] as Map<string, BatchState>;
}

function batchKey(selfId: number, groupId: number): string {
  return `${selfId}:${groupId}`;
}

async function flushBatch(options: {
  ctx: MiokiContext;
  aiService?: AIService;
  config: BootPluginConfig;
  selfId: number;
  groupId: number;
  groupName: string;
  members: PendingMember[];
}): Promise<string> {
  const { ctx, aiService, config, selfId, groupId, groupName, members } = options;
  if (!members.length) return "";

  const names = members.map((m) => m.memberName || String(m.userId));
  const userList = names.join("、");
  const userIdList = members.map((m) => String(m.userId)).join(", ");

  const fallbackText =
    normalizeGeneratedText(
      renderTemplate(config.group.welcome.text, {
        user: userList,
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
        `当前有 ${members.length} 位新成员同时入群，请一次性发送一段统一的欢迎语（不要逐个 @ 欢迎、不要重复点名）。`,
        `新成员昵称：${userList}`,
        `新成员 QQ：${userIdList}`,
        `所在群：${groupName}`,
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
  const batches = getBatchMap();

  const dispose = ctx.handle("notice.group.increase" as any, async (event: any) => {
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

    const batchWindowMs = Math.max(0, Number(cfg.group.welcome.batchWindowMs) || 0);

    if (batchWindowMs === 0) {
      const memberName = await resolveMemberName(ctx, groupId, userId, selfId);
      const welcomeMessage = await flushBatch({
        ctx,
        aiService,
        config: cfg,
        selfId,
        groupId,
        groupName,
        members: [{ userId, memberName }],
      });
      if (!welcomeMessage) return;
      try {
        await bot.sendGroupMsg(groupId, [ctx.segment.text(welcomeMessage)]);
      } catch (error) {
        ctx.logger.warn(`发送入群欢迎失败: ${error}`);
      }
      return;
    }

    const key = batchKey(selfId, groupId);
    let state = batches.get(key);
    if (!state) {
      state = { members: [], timer: null, groupName };
      batches.set(key, state);
    }
    if (groupName && groupName !== String(groupId)) {
      state.groupName = groupName;
    }

    const memberName = await resolveMemberName(ctx, groupId, userId, selfId);
    if (!state.members.some((m) => m.userId === userId)) {
      state.members.push({ userId, memberName });
    }

    if (state.timer) {
      return;
    }

    state.timer = setTimeout(async () => {
      try {
        const pending = state;
        batches.delete(key);
        if (!pending || !pending.members.length) return;

        const currentConfig = getConfig();
        const welcomeMessage = await flushBatch({
          ctx,
          aiService,
          config: currentConfig,
          selfId,
          groupId,
          groupName: pending.groupName,
          members: pending.members,
        });
        if (!welcomeMessage) return;

        try {
          await bot.sendGroupMsg(groupId, [ctx.segment.text(welcomeMessage)]);
        } catch (error) {
          ctx.logger.warn(`发送入群欢迎失败: ${error}`);
        }
      } catch (error) {
        ctx.logger.error(`boot welcome 批次处理失败: ${error}`);
      }
    }, batchWindowMs);
  });

  return () => {
    for (const state of batches.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    batches.clear();
    dispose();
  };
}