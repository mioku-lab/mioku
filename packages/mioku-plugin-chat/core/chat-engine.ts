import type { AIInstance, AITool, Logger, ToolCallRecord } from "mioku";
import type {
  ChatMessage,
  ChatResult,
  TargetMessage,
  ToolContext,
} from "../types";
import type { HumanizeEngine } from "../humanize";
import type { SkillSessionManager } from "../manage/skill-session";
import { buildStructuredUserMessages } from "../manage/group-structured-history";
import { mainModelSupportsVision } from "../utils/model";
import { isRecord } from "../utils/record";
import { createTools } from "./tools";
import {
  buildDynamicUserContext,
  buildStaticSystemPrompt,
  type TurnPrompt,
} from "./prompt";
import {
  isExternalSkillAllowed,
  isSkillAllowedForRole,
} from "./external-skills";
import {
  mergeQuoteMarkerUnits,
  splitOutgoingUnits,
} from "./media/markdown-message";
import { prepareImageUrlsForModel } from "./media/image-compress";
import { cleanMarkers } from "./engine/reply-text";
import { createReplyStream } from "./engine/reply-stream";
import {
  buildRequestMessages,
  persistStructuredHistory,
  type StructuredHistoryRunContext,
} from "./engine/request-messages";
import { buildSessionTools, createWebToolBudget } from "./engine/session-tools";
import {
  estimateChatHistoryTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "./engine/token-estimate";
import {
  buildUsageContext,
  generateToolFailureReply,
  isToolErrorResult,
} from "./engine/tool-failure";

export type { StructuredHistoryRunContext };

/** 引擎依赖的插件级单例 */
export interface ChatEngineDeps {
  aiInstance: AIInstance;
  humanize: HumanizeEngine;
  skillManager: SkillSessionManager;
}

/** 一轮对话的输入 */
export interface ChatEngineTurn {
  toolCtx: ToolContext;
  history: ChatMessage[];
  targetMessage: TargetMessage;
  prompt: TurnPrompt;
  structuredHistory?: StructuredHistoryRunContext;
  extraTools?: AITool[];
}

/** 在当前请求内跑一轮工具循环 */
export async function runChat(
  deps: ChatEngineDeps,
  turn: ChatEngineTurn,
): Promise<ChatResult> {
  const { aiInstance: ai, humanize, skillManager } = deps;
  const { toolCtx, history, targetMessage, prompt, extraTools } = turn;
  const { config, sessionId, aiService } = toolCtx;
  const log = toolCtx.ctx.logger;

  const { tools: chatTools } = createTools(toolCtx, skillManager);
  const activeSkillsInfo = skillManager.getActiveSkillsInfo(
    sessionId,
    (skillName) =>
      config.enableExternalSkills &&
      isExternalSkillAllowed(config, skillName) &&
      isSkillAllowedForRole(
        aiService.getSkill(skillName),
        toolCtx.triggerSkillRole,
      ),
  );

  const staticPrompt = buildStaticSystemPrompt({
    config,
    aiService,
    triggerSkillRole: toolCtx.triggerSkillRole,
    emojiAgent: humanize.emojiAgent,
  });
  const dynamicUserContext = buildDynamicUserContext({
    ...prompt,
    config,
    chatHistory: history,
    targetMessage,
    currentEmotion: humanize.emotionAgent.getCurrent(sessionId).current,
    activeSkillsInfo: activeSkillsInfo || undefined,
  });

  log.info(
    `[chat-engine] Session ${sessionId} | target: ${targetMessage.userName}(${targetMessage.userId}): "${targetMessage.content}"`,
  );
  if (config.debug) {
    log.info("[chat-engine] === Static System Prompt ===");
    log.info(staticPrompt);
    log.info("[chat-engine] === Dynamic User Context ===");
    log.info(dynamicUserContext);
    log.info("[chat-engine] === End Prompts ===");
  }

  const structured =
    toolCtx.groupId && turn.structuredHistory?.currentUserInputs.length
      ? turn.structuredHistory
      : undefined;
  const cachedHistory = structured
    ? structured.manager.getMessages(sessionId, structured.ttlMs)
    : [];
  const currentUserMessages = structured
    ? buildStructuredUserMessages(structured.currentUserInputs)
    : [];
  const directImageUrls = mainModelSupportsVision(aiService, config.model)
    ? toolCtx.pendingImageUrls
    : undefined;

  const usageId = `chat:${sessionId}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const systemPromptTokens = estimateTextTokens(staticPrompt);
  const chatHistoryTokens = estimateChatHistoryTokens(history);
  const currentUserTokens = estimateMessagesTokens(
    buildRequestMessages({
      staticPrompt,
      dynamicUserContext,
      targetMessage,
      currentUserMessages,
      imageUrls: directImageUrls,
    }).filter((message) => message.role !== "system"),
  );
  // 体积过大的图片先压缩再发给主模型；估算按固定 token 计，用原始 URL 即可
  const modelImageUrls = directImageUrls
    ? await prepareImageUrlsForModel(directImageUrls)
    : undefined;
  const usageContext = buildUsageContext(toolCtx, targetMessage, {
    usageId,
    source: "chat",
  });

  if (structured) structured.manager.touch(sessionId, structured.ttlMs);

  const onTextContent = toolCtx.onTextContent;
  const stream =
    config.stream && onTextContent
      ? createReplyStream(async (text, unitIndex, sentIndex) => {
          await onTextContent(text, unitIndex, unitIndex + 1);
          (toolCtx.sentMessageIndices ??= new Set<number>()).add(sentIndex);
        })
      : undefined;
  const webBudget = createWebToolBudget(config.searxng.maxSearchCount);

  const runComplete = () =>
    ai.complete({
      model: config.model,
      messages: buildRequestMessages({
        staticPrompt,
        dynamicUserContext,
        targetMessage,
        cachedHistory,
        currentUserMessages,
        imageUrls: modelImageUrls,
      }),
      usageContext,
      usageContextTokens: chatHistoryTokens,
      usageBreakdown: {
        systemPromptTokens,
        chatHistoryTokens,
        otherContextTokens: currentUserTokens,
      },
      executableToolsProvider: () =>
        buildSessionTools(
          toolCtx,
          {
            chatTools,
            skillTools: skillManager.getTools(sessionId),
            extraTools,
          },
          webBudget,
        ),
      temperature: config.temperature,
      maxIterations: config.maxIterations,
      stream: Boolean(stream),
      onTextDelta: stream ? (delta) => stream.push(delta) : undefined,
    });
  const response = ai.withUsageContext
    ? await ai.withUsageContext(usageContext, runComplete)
    : await runComplete();

  const humanizeInput = {
    sessionId,
    botNickname: prompt.botNickname,
    chatHistory: history,
    targetMessage,
  };
  humanize.emotionAgent
    .refreshIfNeeded(humanizeInput)
    .catch((err) =>
      log.warn(`[chat-engine] background emotion refresh failed: ${err}`),
    );

  if (stream) await stream.end();

  const allToolCalls = response.allToolCalls || [];
  if (config.debug) {
    logRawResponse(log, response.content, response.reasoning, allToolCalls);
  }

  if (shouldEndSession(allToolCalls)) {
    persistStructuredHistory(
      structured,
      sessionId,
      response.turnMessages,
      currentUserMessages,
      [],
    );
    log.info(`[chat-engine] Session ${sessionId} ended by tool`);
    aiService.finalizeUsage?.(usageId, {
      sentUserMessages: 0,
      sentAssistantMessages: 0,
    });
    return {
      messages: [],
      toolCalls: allToolCalls,
      emojiPath: null,
      protocolMessages: response.turnMessages,
    };
  }

  const failedToolCalls = allToolCalls.filter((toolCall) =>
    isToolErrorResult(toolCall.result),
  );
  let cleanedText = cleanMarkers(response.content || "");
  if (failedToolCalls.length > 0 && !cleanedText.trim()) {
    cleanedText = await generateToolFailureReply(
      ai,
      toolCtx,
      staticPrompt,
      targetMessage,
      failedToolCalls,
    );
  }

  if (cleanedText.trim()) {
    const emotionIntent = humanize.emotionAgent.parseEmotionIntent(cleanedText);
    if (emotionIntent) {
      humanize.emotionAgent.setEmotion(sessionId, emotionIntent);
    }
    cleanedText = humanize.emotionAgent.cleanEmotionMarkers(cleanedText).trim();
  }

  let emojiPath: string | null = null;
  let finalText = cleanedText;
  if (cleanedText.trim()) {
    const sticker = await humanize.emojiAgent.processStickerResponse(
      cleanedText,
      humanizeInput,
    );
    finalText = sticker.cleanedText;
    if (sticker.success && sticker.emojiPath) emojiPath = sticker.emojiPath;
  }

  const finalMessages = mergeQuoteMarkerUnits(
    splitOutgoingUnits(finalText),
  ).filter((unit) => unit.trim() && unit.trim() !== "---");
  const outgoingMessages =
    stream && stream.sent.length > 0 ? [...stream.sent] : finalMessages;
  aiService.finalizeUsage?.(usageId, {
    sentUserMessages: 1,
    sentAssistantMessages: outgoingMessages.length,
  });

  log.info(
    `[chat-engine] Session ${sessionId} done | ${finalMessages.length} msg(s), ${allToolCalls.length} tool call(s)`,
  );

  persistStructuredHistory(
    structured,
    sessionId,
    response.turnMessages,
    currentUserMessages,
    finalMessages,
  );

  return {
    messages: outgoingMessages,
    toolCalls: allToolCalls,
    emojiPath,
    protocolMessages: response.turnMessages,
  };
}

function shouldEndSession(toolCalls: ToolCallRecord[]): boolean {
  return toolCalls.some(
    (toolCall) =>
      toolCall.name === "end_session" &&
      isRecord(toolCall.result) &&
      Boolean(toolCall.result.ended),
  );
}

function logRawResponse(
  log: Logger,
  content: string | null,
  reasoning: string | null,
  toolCalls: ToolCallRecord[],
): void {
  log.info("[chat-engine] === Raw AI Reply ===");
  log.info(content || "(empty)");
  log.info("[chat-engine] === End Raw AI Reply ===");
  if (reasoning) log.info(`[chat-engine] AI reasoning: ${reasoning}`);
  for (const toolCall of toolCalls) {
    const resultPreview = JSON.stringify(toolCall.result);
    log.info(
      `[chat-engine] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 100)})`,
    );
    log.info(
      `[chat-engine] Tool result: ${toolCall.name} -> ${resultPreview ? resultPreview.substring(0, 300) : "undefined"}`,
    );
  }
}
