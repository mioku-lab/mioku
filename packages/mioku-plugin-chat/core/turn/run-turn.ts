import type {
  AITool,
  ChatRuntimePromptInjection,
  MiokuContext,
} from "mioku";
import type { ChatPluginContext } from "../../context";
import type {
  ChatConfig,
  ChatMessage,
  ChatResult,
  ChatTarget,
  ChatTurnEvent,
  GroupEventContexts,
  ReplyContextType,
  ReviewMessages,
  TargetMessage,
} from "../../types";
import type { HumanizeEngine } from "../../humanize";
import type { SessionTurnSource } from "../../manage/session-turn-scheduler";
import {
  structuredInputOf,
  type StructuredUserInput,
} from "../../manage/group-structured-history";
import { getBotRole, getGroupInfoData } from "../../utils/group";
import { runChat } from "../chat-engine";
import type { TurnPrompt } from "../prompt";
import { loadChatHistory } from "../history/group-history";
import { buildToolContext } from "./tool-context";
import { finalizeChatTurn } from "./finalize";

interface TurnPolicy {
  replyType: ReplyContextType;
  /** AI 请求限流标签；为空则不经过限流守卫 */
  rateLimitLabel?: (target: ChatTarget) => string;
  /** full：话题 + 发言风格样本；topic：只要话题 */
  humanize: "full" | "topic";
  structuredHistory: boolean;
  /** 群聊里同时确保触发者的个人会话 */
  personalSession: boolean;
  /** 由真实消息事件触发 */
  live: boolean;
}

/** 各触发来源的差异集中在这里；群事件上下文对所有群聊轮次生效 */
const TURN_POLICIES: Record<SessionTurnSource, TurnPolicy> = {
  message: {
    replyType: "reply",
    rateLimitLabel: (t) => (t.groupId ? "group-chat" : "private-chat"),
    humanize: "full",
    structuredHistory: true,
    personalSession: true,
    live: true,
  },
  poke: {
    replyType: "poked",
    rateLimitLabel: () => "poke",
    humanize: "full",
    structuredHistory: true,
    personalSession: false,
    live: true,
  },
  cooldown: {
    replyType: "review",
    rateLimitLabel: () => "cooldown",
    humanize: "full",
    structuredHistory: true,
    personalSession: false,
    live: true,
  },
  "dynamic-delay": {
    replyType: "review",
    rateLimitLabel: () => "dynamic-delay",
    humanize: "full",
    structuredHistory: true,
    personalSession: false,
    live: true,
  },
  "queued-message": {
    replyType: "comment",
    rateLimitLabel: () => "queue",
    humanize: "full",
    structuredHistory: true,
    personalSession: false,
    live: true,
  },
  "chat-runtime": {
    replyType: "reply",
    humanize: "topic",
    structuredHistory: false,
    personalSession: true,
    live: false,
  },
};

export interface ChatTurnRequest {
  source: SessionTurnSource;
  target: ChatTarget;
  cfg: ChatConfig;
  /** 回复用的事件（取 bot、引用回复）；合并多条时取第一条 */
  event?: ChatTurnEvent;
  /** 本轮涉及的所有发送者，技能权限按其中最低的身份；缺省只看 event */
  authEvents?: readonly ChatTurnEvent[];
  /** 可以传 Promise：调用方并行准备的内容会在拉完历史之后再等 */
  targetMessage: TargetMessage | Promise<TargetMessage>;
  /** 写进结构化历史的本轮输入，缺省取 targetMessage */
  structuredInputs?: StructuredUserInput[];
  reviewMessages?: ReviewMessages;
  pendingImageUrls?: string[];
  promptInjections?: ChatRuntimePromptInjection[];
  extraTools?: AITool[];
  /** false：只生成不发送 */
  send?: boolean;
}

/** 跑一轮对话：准备上下文 → 调模型 → 发送入库；被限流时返回 null */
export async function runChatTurn(
  pluginCtx: ChatPluginContext,
  req: ChatTurnRequest,
): Promise<ChatResult | null> {
  const policy = TURN_POLICIES[req.source];
  const { ctx, db, sessionManager } = pluginCtx;
  const { target, cfg, event } = req;
  const { groupId, selfId, sessionId, userId } = target;
  const send = req.send !== false;

  sessionManager.getOrCreate(
    sessionId,
    groupId ? "group" : "personal",
    groupId ?? userId,
  );
  if (policy.personalSession && groupId && userId) {
    sessionManager.getOrCreate(`personal:${userId}`, "personal", userId);
  }

  const [history, botRole, groupInfo] = await Promise.all([
    loadChatHistory(ctx, db, target, cfg.historyCount),
    groupId ? getBotRole(ctx, groupId, selfId) : ("member" as const),
    groupId
      ? getGroupInfoData(ctx, groupId, selfId, event?.group_name)
      : { groupName: event?.group_name, memberCount: undefined },
  ]);
  const targetMessage = await req.targetMessage;

  const prompt: TurnPrompt = {
    botNickname: resolveBotNickname(ctx, cfg, selfId, event),
    botRole,
    isGroup: Boolean(groupId),
    groupName: groupInfo.groupName,
    memberCount: groupInfo.memberCount,
    ...getHumanizeContexts(
      ctx,
      pluginCtx.humanize,
      policy.humanize,
      { sessionId, userId, userName: targetMessage.userName },
      history,
    ),
    ...buildEventContexts(pluginCtx, target, history),
    replyType: policy.replyType,
    reviewMessages: req.reviewMessages,
    promptInjections: req.promptInjections,
  };

  const toolCtx = buildToolContext(pluginCtx, {
    target,
    cfg,
    event,
    authEvents: req.authEvents ?? (event ? [event] : []),
    pendingImageUrls: req.pendingImageUrls,
    stream: send,
  });
  const structuredHistory =
    policy.structuredHistory && groupId
      ? {
          manager: pluginCtx.groupStructuredHistory,
          ttlMs: cfg.groupStructuredHistoryTtlMs,
          currentUserInputs: req.structuredInputs ?? [
            structuredInputOf(targetMessage),
          ],
        }
      : undefined;

  const run = () =>
    runChat(pluginCtx, {
      toolCtx,
      history,
      targetMessage,
      prompt,
      structuredHistory,
      extraTools: req.extraTools,
    });
  const label = policy.rateLimitLabel?.(target);
  const result = label
    ? await pluginCtx.runWithRateLimitGuard(run, {
        userId,
        groupId,
        label,
        skipRetryOnRateLimit: true,
      })
    : await run();
  if (!result) return null;

  await finalizeChatTurn(pluginCtx, {
    target,
    cfg,
    event,
    result,
    toolCtx,
    send,
    live: policy.live,
  });
  return result;
}

function resolveBotNickname(
  ctx: MiokuContext,
  cfg: ChatConfig,
  selfId: string,
  event: ChatTurnEvent | undefined,
): string {
  return (
    cfg.nicknames[0] ||
    ctx.pickBot(selfId)?.nickname ||
    event?.bot?.nickname ||
    "Bot"
  );
}

interface HumanizeContexts {
  topicContext?: string;
  styleSamples?: string;
}

function getHumanizeContexts(
  ctx: MiokuContext,
  humanize: HumanizeEngine,
  scope: TurnPolicy["humanize"],
  who: { sessionId: string; userId: string; userName: string },
  history: ChatMessage[],
): HumanizeContexts {
  const { sessionId, userId, userName } = who;

  const topicContext = humanize.topicTracker.getTopicContext(
    sessionId,
    history[0]?.timestamp,
  );
  const styleSamples =
    scope === "full" && userId
      ? humanize.expressionSampler.buildStyleSamples(userId, userName, sessionId)
      : "";

  ctx.logger.info(
    `[getHumanizeContexts] session=${sessionId} user=${userName} triggerUserId=${scope === "full" ? userId : undefined} topicContext="${topicContext?.slice(0, 100) ?? ""}" styleSamples=${styleSamples.length} 字`,
  );
  return {
    topicContext: topicContext || undefined,
    styleSamples: styleSamples || undefined,
  };
}

function buildEventContexts(
  pluginCtx: ChatPluginContext,
  target: ChatTarget,
  history: ChatMessage[],
): GroupEventContexts {
  if (!target.groupId) return {};
  const historyIds = new Set<string>();
  for (const msg of history) {
    const id = String(msg.messageId ?? "").trim();
    if (id) historyIds.add(id);
  }
  return pluginCtx.groupEvents.buildContexts({
    groupId: target.groupId,
    selfId: target.selfId,
    historySince: history[0]?.timestamp,
    historyIds,
  });
}
