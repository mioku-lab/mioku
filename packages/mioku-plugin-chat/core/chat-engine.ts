import type { AIInstance, SessionToolDefinition } from "mioku";
import type { AITool } from "mioku";
import type {
  ToolContext,
  ChatMessage,
  TargetMessage,
  ChatResult,
} from "../types";
import type { HumanizeEngine } from "../humanize";
import type { StaticPromptContext, DynamicPromptContext } from "./prompt";
import type { SkillSessionManager } from "../manage/skill-session";
import { createTools } from "./tools";
import { buildStaticSystemPrompt, buildDynamicUserContext } from "./prompt";
import type { PromptCtxForRunChat } from "../manage/types";
import {
  isExternalSkillAllowed,
  isSkillAllowedForRole,
} from "./external-skills";
import {
  consumeCompleteStreamUnits,
  isQuoteMarkerOnlyUnit,
  mergeQuoteMarkerUnits,
  splitOutgoingUnits,
} from "./media/markdown-message";
import {
  attachImagesToCurrentUserMessages,
  buildStructuredUserMessages,
  GroupStructuredHistoryManager,
  type StructuredUserInput,
} from "../manage/group-structured-history";
import { prepareImageUrlsForModel } from "./media/image-compress";

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
  promptCtx: PromptCtxForRunChat,
  humanize: HumanizeEngine,
  skillManager: SkillSessionManager,
  structuredHistory?: StructuredHistoryRunContext,
  runtimeOptions?: ChatRuntimeRunOptions,
): Promise<ChatResult> {
  const { tools: chatTools } = createTools(toolCtx, skillManager);
  const skillTools = skillManager.getTools(toolCtx.sessionId);
  const activeSkillsInfo = skillManager.getActiveSkillsInfo(
    toolCtx.sessionId,
    (skillName: string) => {
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
  const emotionState = humanize.emotionAgent.getCurrent(toolCtx.sessionId);

  const staticCtx: StaticPromptContext = {
    config: promptCtx.config,
    aiService: promptCtx.aiService,
    enableExternalSkills: promptCtx.config.enableExternalSkills,
    triggerSkillRole: toolCtx.triggerSkillRole,
    emojiAgent: humanize.emojiAgent,
    skillManager,
    sessionId: toolCtx.sessionId,
  };
  const dynamicCtx: DynamicPromptContext = {
    ...promptCtx,
    chatHistory: history,
    targetMessage,
    currentEmotion: emotionState.current,
    activeSkillsInfo: activeSkillsInfo || undefined,
  };

  const staticPrompt = buildStaticSystemPrompt(staticCtx);
  const dynamicUserContext = buildDynamicUserContext(dynamicCtx);

  const engineLog = toolCtx.ctx.logger;
  engineLog.info(
    `[chat-engine] Session ${toolCtx.sessionId} | target: ${targetMessage.userName}(${targetMessage.userId}): "${targetMessage.content}"`,
  );
  if (toolCtx.config.debug) {
    engineLog.info("[chat-engine] === Static System Prompt ===");
    engineLog.info(staticPrompt);
    engineLog.info("[chat-engine] === Dynamic User Context ===");
    engineLog.info(dynamicUserContext);
    engineLog.info("[chat-engine] === End Prompts ===");
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
  const webSearchState = { count: 0 };
  const usageId = `chat:${toolCtx.sessionId}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const systemPromptTokens = estimateTextTokens(staticPrompt);
  const chatHistoryTokens = estimateChatHistoryTokens(history);
  const currentUserTokens = estimateMessageContentTokens(
    buildCurrentMessages(
      staticPrompt,
      dynamicUserContext,
      targetMessage,
      [],
      currentUserMessages,
      directImageUrls,
    ).filter((message) => message.role !== "system"),
  );
  // 体积过大的图片先压缩，再附加到主模型请求；估算用原始 URL 即可（图片按固定 token 计）。
  const modelImageUrls = directImageUrls
    ? await prepareImageUrlsForModel(directImageUrls)
    : undefined;
  const usageContext = {
    usageId,
    source: "chat",
    botId: getEventNumber(toolCtx.event, "self_id"),
    groupId: toolCtx.groupId,
    groupName: getEventString(toolCtx.event, "group_name"),
    userId: toolCtx.userId,
    userName: targetMessage.userName,
    sessionId: toolCtx.sessionId,
  };

  if (hasStructuredHistory) {
    structuredHistory!.manager.touch(
      toolCtx.sessionId,
      structuredHistory!.ttlMs,
    );
  }

  const streamEnabled = Boolean(toolCtx.config.stream);
  const streamedMessages: string[] = [];
  const streamThinkFilter = createThinkTagStreamFilter();
  let streamBuffer = "";
  let streamUnitIndex = 0;

  const emitStreamSegment = async (
    segment: string,
    unitIndex: number,
  ): Promise<void> => {
    const text = removeStickerIntentLines(cleanMarkers(segment))
      .replace(/\[emotion:[^\]]+\]/gi, "")
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

  let pendingQuoteMarkerLines: string[] = [];
  const flushStreamBuffer = async (force: boolean): Promise<void> => {
    while (true) {
      const { units, rest } = consumeCompleteStreamUnits(streamBuffer, force);
      if (units.length === 0) {
        streamBuffer = rest;
        break;
      }

      streamBuffer = rest;
      for (const unit of units) {
        if (!unit.trim()) {
          continue;
        }
        if (isQuoteMarkerOnlyUnit(unit)) {
          pendingQuoteMarkerLines.push(unit.trim());
          continue;
        }
        const mergedUnit = pendingQuoteMarkerLines.length
          ? [...pendingQuoteMarkerLines, unit].join("\n")
          : unit;
        pendingQuoteMarkerLines = [];
        const unitIndex = streamUnitIndex;
        streamUnitIndex += 1;
        await emitStreamSegment(mergedUnit, unitIndex);
      }

      if (!force) {
        break;
      }
    }
    if (force) {
      pendingQuoteMarkerLines = [];
    }
  };

  const runComplete = () =>
    ai.complete({
      model: toolCtx.config.model,
      messages: buildCurrentMessages(
        staticPrompt,
        dynamicUserContext,
        targetMessage,
        cachedHistory,
        currentUserMessages,
        modelImageUrls,
      ),
      usageContext,
      usageContextTokens: chatHistoryTokens,
      usageBreakdown: {
        systemPromptTokens,
        chatHistoryTokens,
        otherContextTokens: currentUserTokens,
      },
      executableToolsProvider: () =>
        buildSessionTools(
          chatTools,
          skillManager.getTools(toolCtx.sessionId),
          toolCtx,
          runtimeOptions?.extraTools,
          webSearchState,
        ),
      temperature: toolCtx.config.temperature,
      maxIterations: toolCtx.config.maxIterations,
      stream: streamEnabled,
      onTextDelta: streamEnabled
        ? async (delta) => {
            streamBuffer += streamThinkFilter.push(delta, false);
            await flushStreamBuffer(false);
          }
        : undefined,
    });
  const response = ai.withUsageContext
    ? await ai.withUsageContext(usageContext, runComplete)
    : await runComplete();

  humanize.emotionAgent
    .refreshIfNeeded({
      sessionId: toolCtx.sessionId,
      botNickname: promptCtx.botNickname,
      chatHistory: history,
      targetMessage,
    })
    .catch((err) =>
      toolCtx.ctx.logger.warn(
        `[chat-engine] background emotion refresh failed: ${err}`,
      ),
    );

  if (streamEnabled) {
    streamBuffer += streamThinkFilter.push("", true);
    await flushStreamBuffer(true);
  }

  if (toolCtx.config.debug) {
    toolCtx.ctx.logger.info("[chat-engine] === Raw AI Reply ===");
    toolCtx.ctx.logger.info(response.content || "(empty)");
    toolCtx.ctx.logger.info("[chat-engine] === End Raw AI Reply ===");
  }

  const allToolCalls = response.allToolCalls || [];

  const maxSearchCount = toolCtx.config.searxng.maxSearchCount;
  if (maxSearchCount > 0 && webSearchState.count >= maxSearchCount) {
    const limitMsg = `[system] Web search/read-page limit (${maxSearchCount}) reached for this conversation. `;
    response.content = limitMsg + (response.content || "");
  }

  if (toolCtx.config.debug && response.reasoning) {
    toolCtx.ctx.logger.info(
      `[chat-engine] AI reasoning: ${response.reasoning}`,
    );
  }

  if (toolCtx.config.debug && allToolCalls.length > 0) {
    for (const toolCall of allToolCalls) {
      const resultPreview = JSON.stringify(toolCall.result);
      toolCtx.ctx.logger.info(
        `[chat-engine] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 100)})`,
      );
      toolCtx.ctx.logger.info(
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
    toolCtx.ctx.logger.info(
      `[chat-engine] Session ${toolCtx.sessionId} ended by tool`,
    );
    toolCtx.aiService.finalizeUsage?.(usageId, {
      sentUserMessages: 0,
      sentAssistantMessages: 0,
    });
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
      staticPrompt,
      targetMessage,
      failedToolCalls,
    );
  }

  if (cleanedText.trim()) {
    const emotionIntent = humanize.emotionAgent.parseEmotionIntent(cleanedText);
    if (emotionIntent) {
      humanize.emotionAgent.setEmotion(toolCtx.sessionId, emotionIntent);
    }
    cleanedText = humanize.emotionAgent.cleanEmotionMarkers(cleanedText).trim();
  }

  let emojiPath: string | null = null;
  let finalText = cleanedText;
  if (cleanedText.trim()) {
    const stickerResult = await humanize.emojiAgent.processStickerResponse(
      cleanedText,
      {
        sessionId: toolCtx.sessionId,
        botNickname: promptCtx.botNickname,
        chatHistory: history,
        targetMessage,
      },
    );
    finalText = stickerResult.cleanedText;
    if (stickerResult.success && stickerResult.emojiPath) {
      emojiPath = stickerResult.emojiPath;
    }
  }

  const finalMessages = mergeQuoteMarkerUnits(
    splitOutgoingUnits(finalText),
  ).filter((unit) => unit.trim() && unit.trim() !== "---");
  const sentAssistantMessages = streamEnabled
    ? streamedMessages.length
    : finalMessages.length;
  toolCtx.aiService.finalizeUsage?.(usageId, {
    sentUserMessages: 1,
    sentAssistantMessages,
  });

  toolCtx.ctx.logger.info(
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

function estimateChatHistoryTokens(history: ChatMessage[]): number {
  if (history.length === 0) return 0;
  return estimateTextTokens(
    history
      .map((message) =>
        [
          message.userName,
          message.userId,
          message.userRole,
          message.userTitle,
          message.messageId,
          message.content,
        ]
          .filter((value) => value !== undefined && value !== null)
          .join(" "),
      )
      .join("\n"),
  );
}

function estimateMessageContentTokens(
  messages: Array<{ content?: unknown }>,
): number {
  return messages.reduce(
    (sum, message) => sum + estimateContentTokens(message.content),
    0,
  );
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return sum + estimateTextTokens(record.text);
    }
    if (record.type === "image_url") {
      return sum + 85;
    }
    return sum + estimateTextTokens(JSON.stringify(record));
  }, 0);
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjkChars =
    normalized.match(/[\u3400-\u9fff\u3040-\u30ff]/g)?.length || 0;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length || 0;
  const symbols = Math.max(0, normalized.length - cjkChars);
  return Math.max(
    1,
    Math.ceil(cjkChars * 0.6 + latinWords * 1.3 + symbols / 6),
  );
}

function buildCurrentMessages(
  staticPrompt: string,
  dynamicUserContext: string,
  targetMessage: TargetMessage,
  cachedHistory: any[] = [],
  currentUserMessages: any[] = [],
  pendingImageUrls?: string[],
): any[] {
  const messages: any[] = [{ role: "system", content: staticPrompt }];
  messages.push(...cachedHistory);

  if (currentUserMessages.length > 0) {
    messages.push(
      ...prependDynamicContextToFirstUserMessage(
        attachImagesToCurrentUserMessages(
          currentUserMessages,
          pendingImageUrls,
        ),
        dynamicUserContext,
        pendingImageUrls,
      ),
    );
    return messages;
  }

  const hasImages = Boolean(pendingImageUrls && pendingImageUrls.length > 0);
  const userText = `${dynamicUserContext}\n\n---\n\n[User message]\n${targetMessage.content || ""}`;

  if (!hasImages) {
    messages.push({
      role: "user",
      content: userText,
    });
    return messages;
  }

  const userContent: any[] = [{ type: "text", text: userText }];
  for (const url of pendingImageUrls || []) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  messages.push({
    role: "user",
    content: userContent,
  });
  return messages;
}

function prependDynamicContextToFirstUserMessage(
  messages: any[],
  dynamicUserContext: string,
  pendingImageUrls?: string[],
): any[] {
  if (messages.length === 0) return messages;
  const result = [...messages];
  const firstIndex = 0;
  const first = result[firstIndex];
  if (!first || first.role !== "user") return result;

  const hasImages = Boolean(pendingImageUrls && pendingImageUrls.length > 0);

  if (typeof first.content === "string") {
    result[firstIndex] = {
      role: "user",
      content: `${dynamicUserContext}\n\n---\n\n[User message]\n${first.content}`,
    };
    return result;
  }

  if (Array.isArray(first.content) && hasImages) {
    const content = [...first.content];
    const originalText =
      content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n") || "";
    content[0] = {
      type: "text",
      text: `${dynamicUserContext}\n\n---\n\n[User message]\n${originalText}`,
    };
    result[firstIndex] = { role: "user", content };
    return result;
  }

  if (Array.isArray(first.content)) {
    const text = first.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    result[firstIndex] = {
      role: "user",
      content: `${dynamicUserContext}\n\n---\n\n[User message]\n${text}`,
    };
    return result;
  }

  return result;
}

const RATE_LIMITED_TOOL_NAMES = new Set(["web_search", "web_read_page"]);
const RATE_LIMITED_BUILTIN_NAMES = new Set([
  "web_search-web_search",
  "web_search-web_read_page",
]);

function buildSessionTools(
  chatTools: AITool[],
  skillTools: Map<string, AITool>,
  toolCtx: ToolContext,
  extraTools: AITool[] = [],
  webSearchState?: { count: number },
): SessionToolDefinition[] {
  const maxSearchCount = toolCtx.config.searxng.maxSearchCount;
  const tools: SessionToolDefinition[] = [];
  const runtimeContext = createExternalSkillRuntimeContext(toolCtx);
  const rateLimitError = () => ({
    success: false,
    error: `Web search/read-page limit (${maxSearchCount}) reached for this conversation. Answer based on existing information instead of calling web tools again.`,
  });
  const isRateLimited = (name: string) =>
    maxSearchCount > 0 &&
    Boolean(webSearchState) &&
    webSearchState!.count >= maxSearchCount &&
    (RATE_LIMITED_TOOL_NAMES.has(name) || RATE_LIMITED_BUILTIN_NAMES.has(name));

  for (const tool of chatTools) {
    const isRateLimitedTool = RATE_LIMITED_TOOL_NAMES.has(tool.name);
    tools.push({
      name: tool.name,
      tool: {
        ...tool,
        handler: (args: any) => {
          if (isRateLimitedTool && webSearchState) {
            webSearchState.count++;
          }
          if (isRateLimitedTool && isRateLimited(tool.name)) {
            return rateLimitError();
          }
          return tool.handler(args, runtimeContext);
        },
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
    const skillName = name.split("-")[0] || "";
    const skill = toolCtx.aiService.getSkill(skillName);
    if (
      !toolCtx.config.enableExternalSkills ||
      !isExternalSkillAllowed(toolCtx.config, skillName) ||
      !isSkillAllowedForRole(skill, toolCtx.triggerSkillRole)
    ) {
      continue;
    }

    const isRateLimitedName = RATE_LIMITED_BUILTIN_NAMES.has(name);
    tools.push({
      name,
      tool: {
        ...tool,
        handler: (args: any) => {
          if (isRateLimitedName && webSearchState) {
            webSearchState.count++;
          }
          if (isRateLimitedName && isRateLimited(name)) {
            return rateLimitError();
          }
          return tool.handler(args, runtimeContext);
        },
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
    isMultimodal: Boolean(toolCtx.config?.isMultimodal),
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
  let cleaned = stripThinkBlocks(text).trim();

  cleaned = cleaned
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/gi, "")
    .replace(/<｜｜DSML｜｜invoke[^>]*>[\s\S]*?<\/｜｜DSML｜｜invoke>/gi, "")
    .replace(
      /<｜｜DSML｜｜parameter[^>]*>[\s\S]*?<\/｜｜DSML｜｜parameter>/gi,
      "",
    );

  return sanitizeBrackets(cleaned);
}

const FUNCTIONAL_BRACKET_PREFIX =
  /\[(at|reply|poke|audio|emotion):[^\]\n]*\]?/gi;

function sanitizeBrackets(text: string): string {
  if (!text) return text;

  const placeholders: string[] = [];
  let working = text.replace(FUNCTIONAL_BRACKET_PREFIX, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return ` ${idx} `;
  });

  let result = "";
  let orphanLeftCount = 0;
  let i = 0;

  while (i < working.length) {
    const ch = working[i];

    if (ch === " ") {
      const endIdx = working.indexOf(" ", i + 1);
      if (endIdx > i) {
        const idx = parseInt(working.slice(i + 1, endIdx), 10);
        if (!Number.isNaN(idx) && placeholders[idx] !== undefined) {
          result += placeholders[idx];
          i = endIdx + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      while (j < working.length && working[j] !== "]") {
        j++;
      }
      if (j < working.length) {
        i = j + 1;
      } else {
        orphanLeftCount++;
        i++;
      }
      continue;
    }

    if (ch === "]") {
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  if (orphanLeftCount > 0) {
    result += "]".repeat(orphanLeftCount);
  }

  return result;
}

function removeStickerIntentLines(text: string): string {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\]\s*$/.test(line))
    .join("\n");
}

function stripThinkBlocks(text: string): string {
  let source = String(text || "");
  let output = "";

  while (source) {
    const open = findThinkOpenTag(source);
    if (!open) {
      output += source;
      break;
    }

    output += source.slice(0, open.index);
    const afterOpen = source.slice(open.end);
    const close = findThinkCloseTag(afterOpen);
    if (!close) {
      break;
    }

    source = afterOpen.slice(close.end);
  }

  return output.replace(/<\/?(?:think|thinking)\s*>/gi, "");
}

function createThinkTagStreamFilter() {
  let buffer = "";
  let insideThink = false;

  return {
    push(delta: string, force: boolean): string {
      buffer += delta;
      let output = "";

      while (buffer) {
        if (insideThink) {
          const close = findThinkCloseTag(buffer);
          if (!close) {
            buffer = force ? "" : keepTagPrefixSuffix(buffer, "</thinking>");
            break;
          }

          buffer = buffer.slice(close.end);
          insideThink = false;
          continue;
        }

        const open = findThinkOpenTag(buffer);
        if (!open) {
          const keep = force ? "" : keepTagPrefixSuffix(buffer, "<thinking>");
          output += buffer.slice(0, buffer.length - keep.length);
          buffer = keep;
          break;
        }

        output += buffer.slice(0, open.index);
        buffer = buffer.slice(open.end);
        insideThink = true;
      }

      return output.replace(/<\/?(?:think|thinking)\s*>/gi, "");
    },
  };
}

function findThinkOpenTag(text: string): { index: number; end: number } | null {
  const match = /<(think|thinking)\b[^>]*>/i.exec(text);
  return match
    ? { index: match.index, end: match.index + match[0].length }
    : null;
}

function findThinkCloseTag(
  text: string,
): { index: number; end: number } | null {
  const match = /<\/(think|thinking)\s*>/i.exec(text);
  return match
    ? { index: match.index, end: match.index + match[0].length }
    : null;
}

function keepTagPrefixSuffix(text: string, tagPrefix: string): string {
  const maxLength = Math.min(text.length, tagPrefix.length - 1);
  const lowerText = text.toLowerCase();
  const lowerPrefix = tagPrefix.toLowerCase();

  for (let length = maxLength; length > 0; length--) {
    const suffix = lowerText.slice(-length);
    if (lowerPrefix.startsWith(suffix)) {
      return text.slice(-length);
    }
  }

  return "";
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
      usageContext: {
        source: "chat.tool-failure",
        botId: getEventNumber(toolCtx.event, "self_id"),
        groupId: toolCtx.groupId,
        groupName: getEventString(toolCtx.event, "group_name"),
        userId: toolCtx.userId,
        userName: targetMessage.userName,
        sessionId: toolCtx.sessionId,
      },
      temperature: Math.max(0.2, Math.min(0.8, toolCtx.config.temperature)),
      max_tokens: 120,
    });

    const text = cleanMarkers(retry.content || "");
    if (text) {
      return text;
    }
  } catch (err) {
    toolCtx.ctx.logger.warn(
      `[chat-engine] Failed to generate tool-failure fallback reply: ${err}`,
    );
  }

  return "我刚刚查这条信息时出了点问题，你可以换个关键词再试试，或者给我更具体一点的线索。";
}

function getEventNumber(event: unknown, key: string): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getEventString(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
