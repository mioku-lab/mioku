import type { MiokuContext, SkillPermissionRole } from "mioku";
import type { ChatPluginContext } from "../../context";
import type {
  ChatConfig,
  ChatTarget,
  ChatTurnEvent,
  ToolContext,
} from "../../types";
import { eventUserId } from "../../utils/sender";
import { hasSkillPermission } from "../external-skills";
import { sendTextMessage } from "../send/text-message";

export interface ToolContextInput {
  target: ChatTarget;
  cfg: ChatConfig;
  /** 工具里取 bot、读身份用的事件 */
  event?: ChatTurnEvent;
  /** 本轮所有发送者；技能权限取其中最低的身份，为空按普通成员 */
  authEvents: readonly ChatTurnEvent[];
  pendingImageUrls?: string[];
  /** 为 false 时不边生成边发送 */
  stream: boolean;
}

function roleOf(ctx: MiokuContext, event: ChatTurnEvent): SkillPermissionRole {
  if (!eventUserId(event)) return "member";
  if (ctx.isMaster(event)) return "master";
  if (ctx.isOwner(event)) return "owner";
  if (ctx.isAdmin(event)) return "admin";
  return "member";
}

/** 合并多人消息时不能借用某一个人的高权限 */
function resolveTriggerSkillRole(
  ctx: MiokuContext,
  events: readonly ChatTurnEvent[],
): SkillPermissionRole {
  if (events.length === 0) return "member";
  return events
    .map((event) => roleOf(ctx, event))
    .reduce((lowest, role) =>
      hasSkillPermission(lowest, role) ? role : lowest,
    );
}

export function buildToolContext(
  pluginCtx: Pick<ChatPluginContext, "ctx" | "aiService" | "audioService">,
  input: ToolContextInput,
): ToolContext {
  const { ctx, aiService, audioService } = pluginCtx;
  const { target, cfg, event } = input;

  return {
    ctx,
    event,
    sessionId: target.sessionId,
    groupId: target.groupId,
    userId: target.userId,
    triggerSkillRole: resolveTriggerSkillRole(ctx, input.authEvents),
    config: cfg,
    aiService,
    pendingImageUrls: input.pendingImageUrls,
    onTextContent: input.stream
      ? async (text) => {
          const content = text.trim();
          if (!content) return;
          await sendTextMessage(ctx, target, content, {
            config: cfg,
            audioService,
          });
        }
      : undefined,
  };
}
