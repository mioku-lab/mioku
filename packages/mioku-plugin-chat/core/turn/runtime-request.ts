import type {
  AITool,
  ChatRuntimePromptInjection,
  ChatRuntimeSource,
  MiokuContext,
  ToolCallRecord,
} from "mioku";
import type { ChatPluginContext } from "../../context";
import type {
  ChatConfig,
  ChatTarget,
  ChatTurnEvent,
  TargetMessage,
} from "../../types";
import { toOptionalId } from "../../utils/record";
import { eventUserId, senderName, senderTitle } from "../../utils/sender";
import { createChatTarget } from "./target";
import { runChatTurn } from "./run-turn";

const NO_NEW_MESSAGE =
  "[No new user message in this turn. Reply naturally based on the runtime instruction and recent context.]";

export interface ChatRuntimeRequest {
  source: ChatRuntimeSource;
  config: ChatConfig;
  targetMessage?: string;
  promptInjections?: ChatRuntimePromptInjection[];
  extraTools?: AITool[];
  send?: boolean;
}

export interface ChatRuntimeExecution {
  messages: string[];
  toolCalls: ToolCallRecord[];
  collectedInfo: null;
}

interface ResolvedRuntimeTurn {
  target: ChatTarget;
  event: ChatTurnEvent;
  sender: Pick<TargetMessage, "userName" | "userRole" | "userTitle" | "messageId">;
}

function resolveRuntimeTurn(source: ChatRuntimeSource): ResolvedRuntimeTurn {
  if ("event" in source && source.event) {
    const event: ChatTurnEvent = source.event;
    const groupId =
      event.message_type === "group" ? toOptionalId(event.group_id) : undefined;
    const userId = eventUserId(event);
    return {
      target: createChatTarget(String(event.self_id ?? ""), userId, groupId),
      event,
      sender: {
        userName: senderName(event, userId),
        userRole: event.sender?.role || "member",
        userTitle: senderTitle(event.sender),
        messageId: event.message_id,
      },
    };
  }

  const selfId = String(("selfId" in source && source.selfId) || "").trim();
  if (!selfId) throw new Error("Chat runtime requires either event or selfId");
  const groupId = toOptionalId("groupId" in source ? source.groupId : undefined);
  const userId = String(("userId" in source && source.userId) || "").trim();
  if (!groupId && !userId) {
    throw new Error("Chat runtime requires groupId or userId");
  }

  // 没有真实事件时按目标合成一个，供工具和外部技能读取身份
  const event: ChatTurnEvent = {
    self_id: selfId,
    message_type: groupId ? "group" : "private",
    group_id: groupId,
    user_id: userId,
    sender: { user_id: userId, role: "member" },
  };
  return {
    target: createChatTarget(selfId, userId, groupId),
    event,
    sender: { userName: groupId ? "system" : userId, userRole: "member" },
  };
}

function runtimeTargetContent(
  ctx: MiokuContext,
  event: ChatTurnEvent,
  override: string | undefined,
): string {
  if (override?.trim()) return override.trim();
  if (!Array.isArray(event.message)) return NO_NEW_MESSAGE;
  return ctx.text({ message: event.message })?.trim() || NO_NEW_MESSAGE;
}

/** ChatRuntime.generateNotice / requestInformation 发起的一轮；群里与消息轮次串行 */
export async function executeChatRuntimeRequest(
  pluginCtx: ChatPluginContext,
  req: ChatRuntimeRequest,
): Promise<ChatRuntimeExecution> {
  const resolved = resolveRuntimeTurn(req.source);
  const run = () => executeNow(pluginCtx, req, resolved);
  if (!resolved.target.groupId) return run();
  return pluginCtx.sessionTurnScheduler.run(
    resolved.target.sessionId,
    "chat-runtime",
    run,
  );
}

async function executeNow(
  pluginCtx: ChatPluginContext,
  req: ChatRuntimeRequest,
  resolved: ResolvedRuntimeTurn,
): Promise<ChatRuntimeExecution> {
  const { target, event, sender } = resolved;
  const result = await runChatTurn(pluginCtx, {
    source: "chat-runtime",
    target,
    cfg: req.config,
    event,
    targetMessage: {
      ...sender,
      userId: target.userId,
      content: runtimeTargetContent(pluginCtx.ctx, event, req.targetMessage),
      timestamp: Date.now(),
    },
    promptInjections: req.promptInjections,
    extraTools: req.extraTools,
    send: req.send,
  });

  if (!result) {
    pluginCtx.sessionManager.touch(target.sessionId);
    return { messages: [], toolCalls: [], collectedInfo: null };
  }
  return {
    messages: result.messages,
    toolCalls: result.toolCalls,
    collectedInfo: null,
  };
}
