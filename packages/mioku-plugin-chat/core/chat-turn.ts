import type { MiokuContext } from "mioku";
import type { AITool, Bot, ChatRuntimePromptInjection } from "mioku";
import type { ChatPluginContext, ChatRuntimeState } from "../context";
import type { ChatConfig, ChatMessage, TargetMessage } from "../types";
import {
  getGroupHistory,
  getBotRole,
  getQuotedContent,
  mainModelSupportsVision,
} from "../utils";
import { buildStructuredUserInputFromTarget } from "../manage/group-structured-history";

export type RuntimeReplyContextType =
  | "reply"
  | "comment"
  | "idle"
  | "review"
  | "poked";

export interface ExecuteChatRuntimeRequestOptions {
  event?: any;
  selfId?: string;
  groupId?: string;
  userId?: string;
  config: ChatConfig;
  targetMessageContent?: string;
  promptInjections?: ChatRuntimePromptInjection[];
  extraTools?: AITool[];
  send?: boolean;
  replyContextType?: RuntimeReplyContextType;
}

interface ResolvedRuntimeContext {
  event: any;
  isGroup: boolean;
  groupId?: string;
  userId: string;
  selfId: string;
  sessionId: string;
  personalSessionId?: string;
  senderName: string;
  userRole: "owner" | "admin" | "member";
  userTitle?: string;
  groupName?: string;
  messageId?: string;
}

const NO_NEW_MESSAGE =
  "[No new user message in this turn. Reply naturally based on the runtime instruction and recent context.]";

/**
 * 主模型不支持视觉时，引用消息里的图片交给视觉工作模型描述（结果按内容哈希入库复用）。
 * 主模型支持视觉时返回 undefined：图片会直接附到请求里，不必重复描述。
 */
async function describeQuotedImage(
  pluginCtx: ChatPluginContext,
  cfg: ChatConfig,
  imageUrl: string | undefined,
  userId: string,
  groupId: string | undefined,
): Promise<string | undefined> {
  if (
    !imageUrl ||
    mainModelSupportsVision(pluginCtx.aiService, cfg.model)
  ) {
    return undefined;
  }
  const visionAI =
    pluginCtx.visionAIInstance ?? pluginCtx.aiService.getDefault();
  if (!visionAI) return undefined;

  try {
    const { processImage } = await import("./media/image-analyzer");
    const record = await processImage(
      visionAI,
      imageUrl,
      cfg.multimodalWorkingModel,
      pluginCtx.db,
      {
        runAIRequest: (request) =>
          pluginCtx.runWithRateLimitGuard(request, {
            userId,
            groupId,
            label: "quoted-image",
            skipRetryOnRateLimit: true,
          }),
      },
    );
    return record?.description?.trim() || undefined;
  } catch (err) {
    pluginCtx.ctx.logger.error(
      `[chat-turn] Failed to describe quoted image: ${err}`,
    );
    return undefined;
  }
}

function buildRuntimeTargetMessageContent(
  ctx: MiokuContext,
  event: any,
  overrideContent?: string,
): string {
  if (overrideContent?.trim()) return overrideContent.trim();
  if (!event || !event.message || !Array.isArray(event.message))
    return NO_NEW_MESSAGE;
  return ctx.text(event)?.trim() || NO_NEW_MESSAGE;
}

function resolveRuntimeContext(
  ctx: MiokuContext,
  options: ExecuteChatRuntimeRequestOptions,
): ResolvedRuntimeContext {
  if (options.event) {
    const event = options.event;
    const isGroup = event.message_type === "group";
    const groupId: string | undefined = isGroup
      ? String(event.group_id ?? "").trim() || undefined
      : undefined;
    const userId: string = String(
      event.user_id ?? event.sender?.user_id ?? "",
    ).trim();
    return {
      event,
      isGroup,
      groupId,
      userId,
      selfId: event.self_id,
      sessionId: groupId ? `group:${groupId}` : `personal:${userId}`,
      personalSessionId: groupId ? `personal:${userId}` : undefined,
      senderName:
        event.sender?.card || event.sender?.nickname || String(userId),
      userRole: event.sender?.role || "member",
      userTitle: event.sender?.title || undefined,
      groupName: event.group_name,
      messageId: event.message_id,
    };
  }

  const selfId = String(options.selfId ?? "").trim();
  if (!selfId) {
    throw new Error("Chat runtime requires either event or selfId");
  }
  const optionGroupId = String(options.groupId ?? "").trim() || undefined;
  const optionUserId = String(options.userId ?? "").trim();
  if (!optionGroupId && !optionUserId) {
    throw new Error("Chat runtime requires groupId or userId");
  }

  const isGroup = Boolean(optionGroupId);
  const userId = optionUserId;
  const event = {
    self_id: options.selfId,
    message_type: isGroup ? "group" : "private",
    group_id: options.groupId,
    user_id: userId,
    group_name: undefined,
    sender: {
      user_id: userId,
      card: undefined,
      nickname: undefined,
      role: "member",
      title: undefined,
    },
  };

  return {
    event,
    isGroup,
    groupId: optionGroupId,
    userId,
    selfId,
    sessionId: optionGroupId
      ? `group:${optionGroupId}`
      : `personal:${userId}`,
    personalSessionId:
      optionGroupId && userId ? `personal:${userId}` : undefined,
    senderName: optionGroupId ? "system" : String(userId),
    userRole: "member",
    userTitle: undefined,
    groupName: undefined,
    messageId: undefined,
  };
}

// Shared send/save/cooldown tail for both live and runtime turns.
export async function finalizeChatTurn(
  pluginCtx: ChatPluginContext,
  args: {
    event: any;
    cfg: ChatConfig;
    result: { messages: string[]; emojiPath?: string | null };
    groupId?: string;
    groupSessionId: string;
    userId: string;
    selfId: string;
    toolCtx: { sentMessageIndices?: Set<number> };
    send: boolean;
    isLive: boolean;
  },
): Promise<void> {
  if (!args.send) {
    pluginCtx.sessionManager.touch(args.groupSessionId);
    return;
  }
  const { ctx } = pluginCtx;
  const {
    groupId,
    groupSessionId,
    userId,
    selfId,
    cfg,
    toolCtx,
    result,
    event,
  } = args;

  const actingBot = (selfId ? ctx.pickBot(selfId) : undefined) ?? event?.bot;
  const eventBotId = event?.bot ? String(event.bot.bot_id) : undefined;
  const actingIsEventBot =
    eventBotId == null ||
    (actingBot != null && String(actingBot.bot_id) === eventBotId);

  if (groupId) {
    const sentMessageIds = await pluginCtx.sendAIResponse(
      {
        ctx,
        groupId,
        messages: result.messages,
        config: cfg,
        sentIndices: toolCtx.sentMessageIndices,
        audioService: pluginCtx.audioService,
      },
      selfId,
    );
    await pluginCtx.sendEmoji(ctx, groupId, result.emojiPath, actingBot);
    const now = Date.now();
    pluginCtx.saveBotMessages(
      groupId,
      groupSessionId,
      result.messages,
      now,
      cfg,
      pluginCtx.db,
      ctx,
      actingBot,
      sentMessageIds,
    );
    if (args.isLive) {
      pluginCtx.idleCheckManager.recordBotMessages(
        groupSessionId,
        result.messages.length,
        selfId,
      );
    }
    pluginCtx.cooldownManager.startCooldownTimer(
      groupSessionId,
      groupId,
      selfId,
    );
  } else {
    const sentIndices = toolCtx.sentMessageIndices;
    for (let i = 0; i < result.messages.length; i++) {
      if (sentIndices?.has(i)) continue;
      await pluginCtx.sendMessage(
        ctx,
        undefined,
        userId,
        result.messages[i],
        cfg,
        selfId,
        pluginCtx.audioService,
      );
    }
    if (result.emojiPath) {
      try {
        const emojiSegment = ctx.segment.image(`file://${result.emojiPath}`);
        if (args.isLive && actingIsEventBot && event?.reply) {
          await event.reply([emojiSegment]);
        } else {
          if (!actingBot) throw new Error(`bot ${selfId} not found`);
          await actingBot.sendMessage({ type: "private", user_id: userId }, [
            emojiSegment,
          ]);
        }
      } catch (err) {
        ctx.logger.warn(
          args.isLive
            ? `[Emoticon] Send failed: ${err}`
            : `[chat-runtime] Send emoji failed: ${err}`,
        );
      }
    }
  }
  pluginCtx.sessionManager.touch(groupSessionId);
}

// Live message turn — triggered by a real group/private message event.
export async function processChat(
  e: any,
  pluginCtx: ChatPluginContext,
  runtimeState: ChatRuntimeState,
  options: { replyBot?: Bot } = {},
): Promise<void> {
  const { ctx } = pluginCtx;
  const isGroup = e.message_type === "group";
  const groupId: string | undefined = isGroup ? e.group_id : undefined;
  const userId: string = e.user_id || e.sender?.user_id;
  const selfId = options.replyBot ? Number(options.replyBot.bot_id) : e.self_id;
  const cfg = await pluginCtx.getConfig(groupId);

  const personalSessionId = `personal:${userId}`;
  const groupSessionId = groupId ? `group:${groupId}` : personalSessionId;

  if (runtimeState.isRateLimitBlocked()) {
    if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
    return;
  }

  try {
    pluginCtx.sessionManager.getOrCreate(
      groupSessionId,
      groupId ? "group" : "personal",
      groupId ?? userId,
    );
    if (groupId) {
      pluginCtx.sessionManager.getOrCreate(
        personalSessionId,
        "personal",
        userId,
      );
    }

    const quotedInfo = await getQuotedContent(e, ctx);
    const imageUrls: string[] = [];
    if (e.message) {
      for (const seg of e.message) {
        if (seg.type === "image" && (seg.url || seg.data?.url)) {
          imageUrls.push(seg.url || seg.data.url);
        }
      }
    }
    if (quotedInfo?.imageUrl) imageUrls.push(quotedInfo.imageUrl);

    // 与历史拉取并行，省掉视觉描述带来的额外等待
    const quotedImageNotePromise = describeQuotedImage(
      pluginCtx,
      cfg,
      quotedInfo?.imageUrl,
      userId,
      groupId,
    );

    const rawHistory = groupId
      ? await getGroupHistory(
          groupId,
          ctx,
          cfg.historyCount,
          selfId,
          pluginCtx.db,
          pluginCtx.buildHistoryMediaOptions(pluginCtx.aiInstance, cfg),
        )
      : [];
    const history: ChatMessage[] = rawHistory.map((msg: any) => ({
      sessionId: groupSessionId,
      role: msg.role || ("user" as const),
      content: msg.content,
      userId: msg.userId,
      userName: msg.userName,
      userRole: msg.userRole,
      groupId,
      timestamp: msg.timestamp,
      messageId: msg.messageId,
    }));

    const botNickname =
      cfg.nicknames[0] ||
      options.replyBot?.nickname ||
      e.bot?.nickname ||
      "Bot";
    const botRole = groupId ? await getBotRole(groupId, ctx, selfId) : "member";
    let groupName: string | undefined;
    let memberCount: number | undefined;
    if (groupId) {
      const groupInfo = await pluginCtx.getGroupInfoData(
        ctx,
        groupId,
        selfId,
        e.group_name,
      );
      groupName = groupInfo.groupName;
      memberCount = groupInfo.memberCount;
    }

    const senderName = e.sender?.card || e.sender?.nickname || String(userId);
    const contexts = await pluginCtx.getHumanizeContexts(
      pluginCtx.humanize,
      groupSessionId,
      senderName,
      history,
      userId,
    );

    const quotedImageNote = await quotedImageNotePromise;
    let messageContent = ctx.text(e) || "";
    if (quotedInfo) {
      const quotedText =
        quotedInfo.content || (quotedInfo.imageUrl ? "[image]" : "");
      const parts = [
        `[Quoted message #${quotedInfo.messageId} from ${quotedInfo.senderName}: ${quotedText}]`,
      ];
      if (quotedInfo.imageUrl) {
        parts.push(
          quotedImageNote
            ? `[Quoted message image: ${quotedImageNote}]`
            : "[Quoted message contains an image]",
        );
      }
      messageContent = `${parts.join(" ")} ${messageContent}`;
    }

    const targetMessage: TargetMessage = {
      userName: senderName,
      userId,
      userRole: e.sender?.role || "member",
      userTitle: (e.sender as any)?.title || undefined,
      content: messageContent,
      messageId: e.message_id,
      timestamp: Date.now(),
    };

    if (groupId) {
      pluginCtx.queueManager.setActiveTarget(groupSessionId, targetMessage);
    }

    const toolCtx = pluginCtx.buildToolContext({
      ctx,
      event: e,
      groupSessionId,
      groupId,
      userId,
      config: cfg,
      aiService: pluginCtx.aiService,
      db: pluginCtx.db,
      botRole,
      pendingImageUrls: imageUrls,
      humanize: pluginCtx.humanize,
      targetMessage,
      selfId,
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
            groupName,
            memberCount,
            botNickname,
            botRole,
            aiService: pluginCtx.aiService,
            isGroup,
            memoryContext: contexts.memoryContext,
            topicContext: contexts.topicContext,
            expressionContext: contexts.expressionContext,
            replyContext: {
              type: "reply",
              targetUser: targetMessage.userName,
              targetMessage: targetMessage.content,
            },
          },
          pluginCtx.humanize,
          pluginCtx.skillManager,
          groupId
            ? {
                manager: pluginCtx.groupStructuredHistory,
                ttlMs: cfg.groupStructuredHistoryTtlMs,
                currentUserInputs: [
                  pluginCtx.buildStructuredUserInputFromTarget(targetMessage),
                ],
              }
            : undefined,
        ),
      {
        userId,
        groupId,
        label: isGroup ? "group-chat" : "private-chat",
        skipRetryOnRateLimit: true,
      },
    );

    if (!result) {
      if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
      return;
    }

    await finalizeChatTurn(pluginCtx, {
      event: e,
      cfg,
      result,
      groupId,
      groupSessionId,
      userId,
      selfId,
      toolCtx,
      send: true,
      isLive: true,
    });
  } catch (err) {
    ctx.logger.error(`Chat processing failed: ${err}`);
    if (groupId) pluginCtx.queueManager.clearActiveTarget(groupSessionId);
  }
}

type ChatRuntimeExecutionResult = {
  messages: string[];
  toolCalls: Array<{ name: string; arguments: any; result: any }>;
  collectedInfo: null;
};

export async function executeChatRuntimeRequest(
  options: ExecuteChatRuntimeRequestOptions,
  pluginCtx: ChatPluginContext,
): Promise<ChatRuntimeExecutionResult> {
  const runtimeCtx = resolveRuntimeContext(pluginCtx.ctx, options);
  if (!runtimeCtx.isGroup) {
    return executeChatRuntimeRequestNow(options, pluginCtx);
  }
  return pluginCtx.sessionTurnScheduler.run(
    runtimeCtx.sessionId,
    "chat-runtime",
    () => executeChatRuntimeRequestNow(options, pluginCtx),
  );
}

// Runtime turn — triggered by ChatRuntime.generateNotice / requestInformation.
async function executeChatRuntimeRequestNow(
  options: ExecuteChatRuntimeRequestOptions,
  pluginCtx: ChatPluginContext,
): Promise<ChatRuntimeExecutionResult> {
  const cfg = options.config;
  const runtimeCtx = resolveRuntimeContext(pluginCtx.ctx, options);
  const {
    event,
    isGroup,
    groupId,
    userId,
    selfId,
    sessionId,
    personalSessionId,
    senderName,
    userRole,
    userTitle,
    groupName: runtimeGroupName,
    messageId,
  } = runtimeCtx;
  const targetContent = buildRuntimeTargetMessageContent(
    pluginCtx.ctx,
    event,
    options.targetMessageContent,
  );

  pluginCtx.sessionManager.getOrCreate(
    sessionId,
    groupId ? "group" : "personal",
    groupId ?? userId,
  );
  if (groupId && personalSessionId) {
    pluginCtx.sessionManager.getOrCreate(personalSessionId, "personal", userId);
  }

  const rawHistory = groupId
    ? await getGroupHistory(
        groupId,
        pluginCtx.ctx,
        cfg.historyCount,
        selfId,
        pluginCtx.db,
      )
    : [];
  const history: ChatMessage[] = rawHistory.map((msg) => ({
    sessionId,
    role: msg.role || ("user" as const),
    content: msg.content,
    userId: msg.userId,
    userName: msg.userName,
    userRole: msg.userRole,
    groupId,
    timestamp: msg.timestamp,
    messageId: msg.messageId,
  }));

  const botRole = groupId
    ? await getBotRole(groupId, pluginCtx.ctx, selfId)
    : "member";
  const botNickname = cfg.nicknames[0] || event?.bot?.nickname || "Bot";

  let groupName: string | undefined;
  let memberCount: number | undefined;
  if (groupId) {
    const groupInfo = await pluginCtx.getGroupInfoData(
      pluginCtx.ctx,
      groupId,
      selfId,
      runtimeGroupName,
    );
    groupName = groupInfo.groupName;
    memberCount = groupInfo.memberCount;
  } else {
    groupName = runtimeGroupName;
  }

  const contexts = await pluginCtx.getHumanizeContexts(
    pluginCtx.humanize,
    sessionId,
    senderName,
    history,
  );

  const targetMessage: TargetMessage = {
    userName: senderName,
    userId,
    userRole,
    userTitle,
    content: targetContent,
    messageId,
    timestamp: Date.now(),
  };

  const toolCtx = pluginCtx.buildToolContext({
    ctx: pluginCtx.ctx,
    event,
    groupSessionId: sessionId,
    groupId,
    userId,
    config: cfg,
    aiService: pluginCtx.aiService,
    db: pluginCtx.db,
    botRole,
    humanize: pluginCtx.humanize,
    targetMessage,
    selfId,
    audioService: pluginCtx.audioService,
  });

  if (options.send === false) {
    toolCtx.onTextContent = undefined;
    toolCtx.sentMessageIndices = undefined;
  }

  const result = await pluginCtx.runChat(
    pluginCtx.aiInstance,
    toolCtx,
    history,
    targetMessage,
    {
      config: cfg,
      groupName,
      memberCount,
      botNickname,
      botRole,
      aiService: pluginCtx.aiService,
      isGroup,
      memoryContext: contexts.memoryContext,
      topicContext: contexts.topicContext,
      expressionContext: contexts.expressionContext,
      replyContext: {
        type: options.replyContextType || "reply",
        targetUser: targetMessage.userName,
        targetMessage: targetMessage.content,
      },
      promptInjections: options.promptInjections,
    },
    pluginCtx.humanize,
    pluginCtx.skillManager,
    undefined,
    { extraTools: options.extraTools },
  );

  if (!result) {
    pluginCtx.sessionManager.touch(sessionId);
    return {
      messages: [],
      toolCalls: [],
      collectedInfo: null,
    };
  }

  await finalizeChatTurn(pluginCtx, {
    event,
    cfg,
    result,
    groupId,
    groupSessionId: sessionId,
    userId,
    selfId,
    toolCtx,
    send: options.send !== false,
    isLive: false,
  });

  return {
    messages: result.messages,
    toolCalls: result.toolCalls.map((toolCall) => ({
      name: toolCall.name,
      arguments: toolCall.args,
      result: toolCall.result,
    })),
    collectedInfo: null,
  };
}
