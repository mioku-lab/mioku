import type {
  AIInstance,
  SessionToolDefinition,
} from "../../../src/services/ai/types";
import { logger } from "mioki";
import type { AITool } from "../../../src";
import type {
  ToolContext,
  ChatMessage,
  TargetMessage,
  ChatResult,
} from "../types";
import type { HumanizeEngine } from "../humanize";
import type { PromptContext } from "./prompt";
import type { SkillSessionManager } from "./tools";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./prompt";
import {
  isExternalSkillAllowed,
  isSkillAllowedForRole,
} from "./external-skills";
import {
  consumeCompleteStreamUnits,
  splitOutgoingUnits,
} from "./media/markdown-message";
import {
  attachImagesToCurrentUserMessages,
  buildStructuredUserMessages,
  GroupStructuredHistoryManager,
  type StructuredUserInput,
} from "../manage/group-structured-history";

interface StructuredHistoryRunContext {
  manager: GroupStructuredHistoryManager;
  ttlMs: number;
  currentUserInputs: StructuredUserInput[];
}

interface ChatRuntimeRunOptions {
  extraTools?: AITool[];
}

/**
 * Run a single chat turn using a fresh tool loop inside the current request.
 */
export async function runChat(
  ai: AIInstance,
  toolCtx: ToolContext,
  history: ChatMessage[],
  targetMessage: TargetMessage,
  promptCtx: Omit<
    PromptContext,
    "activeSkillsInfo" | "chatHistory" | "targetMessage"
  >,
  humanize: HumanizeEngine,
  skillManager: SkillSessionManager,
  structuredHistory?: StructuredHistoryRunContext,
  runtimeOptions?: ChatRuntimeRunOptions,
): Promise<ChatResult> {
  const { tools: chatTools } = createTools(toolCtx, skillManager);
  const skillTools = skillManager.getTools(toolCtx.sessionId);
  const activeSkillsInfo = skillManager.getActiveSkillsInfo(
    toolCtx.sessionId,
    (skillName) => {
      if (
        !toolCtx.config.enableExternalSkills ||
        !isExternalSkillAllowed(toolCtx.config, skillName)
      ) {
        return false;
      }
      const skill = toolCtx.aiService.getSkill(skillName);
      return isSkillAllowedForRole(skill, toolCtx.triggerSkillRole);
    },
  );
  const prompt = buildSystemPrompt({
    ...promptCtx,
    triggerSkillRole: toolCtx.triggerSkillRole,
    activeSkillsInfo: activeSkillsInfo || undefined,
    chatHistory: history,
    targetMessage,
    emojiAgent: humanize.emojiAgent,
  });

  logger.info(
    `[chat-engine] Session ${toolCtx.sessionId} | target: ${targetMessage.userName}(${targetMessage.userId}): "${targetMessage.content}"`,
  );
  if (toolCtx.config.debug) {
    logger.info("[chat-engine] === Prompt ===");
    logger.info(prompt);
    logger.info("[chat-engine] === End Prompt ===");
  }

  const hasStructuredHistory =
    Boolean(toolCtx.groupId) &&
    Boolean(structuredHistory) &&
    structuredHistory!.currentUserInputs.length > 0;
  const cachedHistory = hasStructuredHistory
    ? structuredHistory!.manager.getMessages(
        toolCtx.sessionId,
        structuredHistory!.ttlMs,
      )
    : [];
  const currentUserMessages = hasStructuredHistory
    ? buildStructuredUserMessages(structuredHistory!.currentUserInputs)
    : [];
  const directImageUrls = toolCtx.config.isMultimodal
    ? toolCtx.pendingImageUrls
    : undefined;

  if (hasStructuredHistory) {
    structuredHistory!.manager.touch(
      toolCtx.sessionId,
      structuredHistory!.ttlMs,
    );
  }

  const streamEnabled = Boolean(toolCtx.config.stream);
  const streamedMessages: string[] = [];
  let streamBuffer = "";
  let streamUnitIndex = 0;

  const emitStreamSegment = async (
    segment: string,
    unitIndex: number,
  ): Promise<void> => {
    const text = cleanMarkers(segment)
      .replace(/\[meme:[^\]]+\]/gi, "")
      .replace(/\r/g, "")
      .trim();
    if (!text || text === "---") {
      return;
    }

    if (toolCtx.onTextContent) {
      await toolCtx.onTextContent(text, unitIndex, unitIndex + 1);
      toolCtx.sentMessageIndices ??= new Set<number>();
      toolCtx.sentMessageIndices.add(unitIndex);
    }
    streamedMessages.push(text);
  };

  const flushStreamBuffer = async (force: boolean): Promise<void> => {
    while (true) {
      const { units, rest } = consumeCompleteStreamUnits(streamBuffer, force);
      if (units.length === 0) {
        streamBuffer = rest;
        break;
      }

      streamBuffer = rest;
      for (const unit of units) {
        const unitIndex = streamUnitIndex;
        streamUnitIndex += 1;
        if (unit.trim()) {
          await emitStreamSegment(unit, unitIndex);
        }
      }

      if (!force) {
        break;
      }
    }
  };

  const response = await ai.complete({
    model: toolCtx.config.model,
    messages: buildCurrentMessages(
      prompt,
      targetMessage,
      cachedHistory,
      currentUserMessages,
      directImageUrls,
    ),
    executableToolsProvider: () =>
      buildSessionTools(
        chatTools,
        skillManager.getTools(toolCtx.sessionId),
        toolCtx,
        runtimeOptions?.extraTools,
      ),
    temperature: toolCtx.config.temperature,
    maxIterations: toolCtx.config.maxIterations,
    stream: streamEnabled,
    onTextDelta: streamEnabled
      ? async (delta) => {
          streamBuffer += delta;
          await flushStreamBuffer(false);
        }
      : undefined,
  });

  if (streamEnabled) {
    await flushStreamBuffer(true);
  }

  if (toolCtx.config.debug) {
    logger.info("[chat-engine] === Raw AI Reply ===");
    logger.info(response.content || "(empty)");
    logger.info("[chat-engine] === End Raw AI Reply ===");
  }

  const allToolCalls = response.allToolCalls || [];

  if (toolCtx.config.debug && response.reasoning) {
    logger.info(`[chat-engine] AI reasoning: ${response.reasoning}`);
  }

  if (toolCtx.config.debug && allToolCalls.length > 0) {
    for (const toolCall of allToolCalls) {
      const resultPreview = JSON.stringify(toolCall.result);
      logger.info(
        `[chat-engine] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 100)})`,
      );
      logger.info(
        `[chat-engine] Tool result: ${toolCall.name} -> ${resultPreview ? resultPreview.substring(0, 300) : "undefined"}`,
      );
    }
  }

  if (shouldEndSession(allToolCalls)) {
    persistStructuredHistory(
      structuredHistory,
      toolCtx.sessionId,
      response.turnMessages,
      currentUserMessages,
      [],
    );
    logger.info(`[chat-engine] Session ${toolCtx.sessionId} ended by tool`);
    return {
      messages: [],
      pendingAt: [],
      pendingPoke: [],
      pendingQuote: undefined,
      toolCalls: allToolCalls.map((toolCall) => ({
        name: toolCall.name,
        args: toolCall.arguments,
        result: toolCall.result,
      })),
      emojiPath: null,
      protocolMessages: response.turnMessages,
    };
  }

  const failedToolCalls = allToolCalls.filter((toolCall) =>
    isToolErrorResult(toolCall.result),
  );
  let cleanedText = cleanMarkers(response.content || "");
  if (failedToolCalls.length > 0) {
    cleanedText = await generateToolFailureReply(
      ai,
      toolCtx,
      prompt,
      targetMessage,
      failedToolCalls,
    );
  }

  let emojiPath: string | null = null;
  let finalText = cleanedText;
  if (cleanedText.trim()) {
    const memeResult = await humanize.emojiAgent.processMemeResponse(
      cleanedText,
      toolCtx.sessionId,
    );
    if (memeResult.success && memeResult.emojiPath) {
      emojiPath = memeResult.emojiPath;
      finalText = memeResult.cleanedText || cleanedText;
    }
  }

  const finalMessages = splitOutgoingUnits(finalText).filter(
    (unit) => unit.trim() && unit.trim() !== "---",
  );

  logger.info(
    `[chat-engine] Session ${toolCtx.sessionId} done | ${finalMessages.length} msg(s), ${allToolCalls.length} tool call(s)`,
  );

  persistStructuredHistory(
    structuredHistory,
    toolCtx.sessionId,
    response.turnMessages,
    currentUserMessages,
    finalMessages,
  );

  return {
    messages: streamEnabled ? [] : finalMessages,
    pendingAt: [],
    pendingPoke: [],
    pendingQuote: undefined,
    toolCalls: allToolCalls.map((toolCall) => ({
      name: toolCall.name,
      args: toolCall.arguments,
      result: toolCall.result,
    })),
    emojiPath,
    protocolMessages: response.turnMessages,
  };
}

function buildCurrentMessages(
  prompt: string,
  targetMessage: TargetMessage,
  cachedHistory: any[] = [],
  currentUserMessages: any[] = [],
  pendingImageUrls?: string[],
): any[] {
  const messages: any[] = [{ role: "system", content: prompt }];
  messages.push(...cachedHistory);

  if (currentUserMessages.length > 0) {
    messages.push(
      ...attachImagesToCurrentUserMessages(
        currentUserMessages,
        pendingImageUrls,
      ),
    );
    return messages;
  }

  const hasImages = Boolean(pendingImageUrls && pendingImageUrls.length > 0);

  if (!hasImages) {
    messages.push({
      role: "user",
      content: targetMessage.content,
    });
    return messages;
  }

  const userContent: any[] = [{ type: "text", text: targetMessage.content }];
  for (const url of pendingImageUrls || []) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  messages.push({
    role: "user",
    content: userContent,
  });
  return messages;
}

function buildSessionTools(
  chatTools: AITool[],
  skillTools: Map<string, AITool>,
  toolCtx: ToolContext,
  extraTools: AITool[] = [],
): SessionToolDefinition[] {
  const tools: SessionToolDefinition[] = [];
  const runtimeContext = createExternalSkillRuntimeContext(toolCtx);

  for (const tool of chatTools) {
    tools.push({
      name: tool.name,
      tool: {
        ...tool,
        handler: (args: any) => tool.handler(args, runtimeContext),
      },
    });
  }

  for (const tool of extraTools) {
    tools.push({
      name: tool.name,
      tool: {
        ...tool,
        handler: (args: any) => tool.handler(args, runtimeContext),
      },
    });
  }

  for (const [name, tool] of skillTools) {
    const skillName = name.split(".")[0] || "";
    const skill = toolCtx.aiService.getSkill(skillName);
    if (
      !toolCtx.config.enableExternalSkills ||
      !isExternalSkillAllowed(toolCtx.config, skillName) ||
      !isSkillAllowedForRole(skill, toolCtx.triggerSkillRole)
    ) {
      continue;
    }

    tools.push({
      name,
      tool: {
        ...tool,
        handler: (args: any) => tool.handler(args, runtimeContext),
      },
    });
  }

  return tools;
}

function createExternalSkillRuntimeContext(toolCtx: ToolContext): any {
  const rawEvent = toolCtx.event || {};
  return {
    ctx: toolCtx.ctx,
    event: rawEvent,
    rawEvent,
    session_id: toolCtx.sessionId,
    trigger_role: toolCtx.triggerSkillRole,
  };
}

function shouldEndSession(
  toolCalls: Array<{ name: string; result: any }>,
): boolean {
  return toolCalls.some((toolCall) => {
    if (toolCall.name !== "end_session") {
      return false;
    }

    const result = toolCall.result;
    return Boolean(result && typeof result === "object" && result.ended);
  });
}

function persistStructuredHistory(
  structuredHistory: StructuredHistoryRunContext | undefined,
  sessionId: string,
  protocolMessages: any[] | undefined,
  currentUserMessages: any[],
  finalMessages: string[],
): void {
  if (!structuredHistory || currentUserMessages.length === 0) {
    return;
  }

  const messages = [...currentUserMessages];
  const protocol = [...(protocolMessages || [])];

  if (protocol.length > 0) {
    const last = protocol[protocol.length - 1];
    if (isPlainAssistantMessage(last)) {
      protocol.pop();
    }
  }

  messages.push(...protocol);
  for (const msg of finalMessages) {
    messages.push({
      role: "assistant",
      content: msg,
    });
  }

  structuredHistory.manager.append(
    sessionId,
    messages,
    structuredHistory.ttlMs,
  );
}

function isPlainAssistantMessage(message: any): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return toolCalls.length === 0;
}

/**
 * Remove action markers from text for storage/display.
 * Note: ALL markers are preserved here - they'll be parsed by parseLineMarkers in index.ts
 */
function cleanMarkers(text: string): string {
  return text
    .replace(/<Ai>\s*<think>[\s\S]*?<\/Ai>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function isToolErrorResult(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.error) return true;
  return result.success === false;
}

async function generateToolFailureReply(
  ai: AIInstance,
  toolCtx: ToolContext,
  chatSystemPrompt: string,
  targetMessage: TargetMessage,
  failedToolCalls: Array<{ name: string; result: any }>,
): Promise<string> {
  const failedSummary = failedToolCalls
    .map((item) => {
      const raw =
        typeof item.result === "string"
          ? item.result
          : JSON.stringify(item.result);
      return `- ${item.name}: ${raw}`;
    })
    .join("\n");
  const userPrompt = `用户原始消息：${targetMessage.content}

补充上下文：你刚才尝试调用工具，但以下工具失败了：
${failedSummary}

请基于当前会话的人设与语气，给用户一条自然、简短的回复。
要求：
- 可以简要提到“刚刚没查到/调用失败”，但不要泄露内部系统细节。
- 给出可执行的下一步建议（如补充关键词、提供更具体链接、稍后再试）。
- 直接输出最终回复文本，不要解释你在做什么。`;

  try {
    const retry = await ai.complete({
      model: toolCtx.config.model,
      messages: [
        { role: "system", content: chatSystemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: Math.max(0.2, Math.min(0.8, toolCtx.config.temperature)),
      max_tokens: 120,
    });

    const text = cleanMarkers(retry.content || "");
    if (text) {
      return text;
    }
  } catch (err) {
    logger.warn(
      `[chat-engine] Failed to generate tool-failure fallback reply: ${err}`,
    );
  }

  return "我刚刚查这条信息时出了点问题，你可以换个关键词再试试，或者给我更具体一点的线索。";
}
