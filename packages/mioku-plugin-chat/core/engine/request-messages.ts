import type { TargetMessage } from "../../types";
import {
  attachImagesToCurrentUserMessages,
  type GroupStructuredHistoryManager,
  type StructuredUserInput,
} from "../../manage/group-structured-history";
import {
  contentText,
  imagePart,
  isChatMessageParam,
  textPart,
  type ChatCompletionMessageParam,
} from "../model-content";

export interface StructuredHistoryRunContext {
  manager: GroupStructuredHistoryManager;
  ttlMs: number;
  currentUserInputs: StructuredUserInput[];
}

export interface RequestMessageParts {
  staticPrompt: string;
  dynamicUserContext: string;
  targetMessage: TargetMessage;
  cachedHistory?: ChatCompletionMessageParam[];
  currentUserMessages?: ChatCompletionMessageParam[];
  imageUrls?: string[];
}

function withDynamicContext(dynamicUserContext: string, text: string): string {
  return `${dynamicUserContext}\n\n---\n\n[User message]\n${text}`;
}

export function buildRequestMessages(
  parts: RequestMessageParts,
): ChatCompletionMessageParam[] {
  const {
    staticPrompt,
    dynamicUserContext,
    targetMessage,
    cachedHistory = [],
    currentUserMessages = [],
    imageUrls,
  } = parts;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: staticPrompt },
    ...cachedHistory,
  ];

  if (currentUserMessages.length > 0) {
    messages.push(
      ...prependDynamicContext(
        attachImagesToCurrentUserMessages(currentUserMessages, imageUrls),
        dynamicUserContext,
        Boolean(imageUrls?.length),
      ),
    );
    return messages;
  }

  const userText = withDynamicContext(
    dynamicUserContext,
    targetMessage.content || "",
  );
  if (!imageUrls?.length) {
    messages.push({ role: "user", content: userText });
    return messages;
  }

  messages.push({
    role: "user",
    content: [textPart(userText), ...imageUrls.map((url) => imagePart(url))],
  });
  return messages;
}

function prependDynamicContext(
  messages: ChatCompletionMessageParam[],
  dynamicUserContext: string,
  hasImages: boolean,
): ChatCompletionMessageParam[] {
  const first = messages[0];
  if (!first || first.role !== "user") return messages;

  const result = [...messages];
  if (typeof first.content === "string") {
    result[0] = {
      role: "user",
      content: withDynamicContext(dynamicUserContext, first.content),
    };
    return result;
  }

  const text = withDynamicContext(
    dynamicUserContext,
    contentText(first.content),
  );
  if (hasImages) {
    const content = [...first.content];
    content[0] = textPart(text);
    result[0] = { role: "user", content };
  } else {
    result[0] = { role: "user", content: text };
  }
  return result;
}

/** 把本轮的用户输入、工具往返与最终回复写进结构化历史 */
export function persistStructuredHistory(
  structuredHistory: StructuredHistoryRunContext | undefined,
  sessionId: string,
  protocolMessages: unknown[],
  currentUserMessages: ChatCompletionMessageParam[],
  finalMessages: string[],
): void {
  if (!structuredHistory || currentUserMessages.length === 0) return;

  const protocol = protocolMessages.filter(isChatMessageParam);
  const last = protocol[protocol.length - 1];
  // 最终回复按拆分后的条目另行写入
  if (last && isPlainAssistantMessage(last)) protocol.pop();

  const messages: ChatCompletionMessageParam[] = [
    ...currentUserMessages,
    ...protocol,
    ...finalMessages.map(
      (content): ChatCompletionMessageParam => ({ role: "assistant", content }),
    ),
  ];
  structuredHistory.manager.append(sessionId, messages, structuredHistory.ttlMs);
}

function isPlainAssistantMessage(message: ChatCompletionMessageParam): boolean {
  return message.role === "assistant" && !message.tool_calls?.length;
}
