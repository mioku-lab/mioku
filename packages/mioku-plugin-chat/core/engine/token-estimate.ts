import type { ChatMessage } from "../../types";
import type { ModelMessage } from "../model-content";

/** 图片按固定 token 估算 */
const IMAGE_TOKENS = 85;

export function estimateTextTokens(text: string): number {
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

export function estimateChatHistoryTokens(history: ChatMessage[]): number {
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

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateContentTokens(message.content);
  }
  return sum;
}

function estimateContentTokens(content: ModelMessage["content"]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;

  let sum = 0;
  for (const part of content) {
    if ("text" in part && typeof part.text === "string") {
      sum += estimateTextTokens(part.text);
    } else if (part.type === "image_url") {
      sum += IMAGE_TOKENS;
    } else {
      sum += estimateTextTokens(JSON.stringify(part));
    }
  }
  return sum;
}
