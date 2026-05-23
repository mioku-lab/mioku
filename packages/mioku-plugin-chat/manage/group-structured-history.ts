import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MultimodalContentItem } from "mioku";

export interface StructuredUserInput {
  userName: string;
  userId: number;
  userRole?: string;
  userTitle?: string;
  content: string;
  messageId?: number;
  timestamp: number;
}

interface GroupStructuredHistoryState {
  lastBotDirectedAt: number;
  messages: ChatCompletionMessageParam[];
}

const DEFAULT_GROUP_STRUCTURED_HISTORY_TTL_MS = 10 * 60_000;

export class GroupStructuredHistoryManager {
  private readonly states = new Map<string, GroupStructuredHistoryState>();

  getMessages(
    sessionId: string,
    ttlMs?: number,
    now: number = Date.now(),
  ): ChatCompletionMessageParam[] {
    this.clearExpired(sessionId, ttlMs, now);
    const state = this.states.get(sessionId);
    return state ? [...state.messages] : [];
  }

  touch(sessionId: string, ttlMs?: number, now: number = Date.now()): void {
    this.clearExpired(sessionId, ttlMs, now);
    const state = this.states.get(sessionId);
    if (state) {
      state.lastBotDirectedAt = now;
      return;
    }

    this.states.set(sessionId, {
      lastBotDirectedAt: now,
      messages: [],
    });
  }

  append(
    sessionId: string,
    messages: ChatCompletionMessageParam[],
    ttlMs?: number,
    now: number = Date.now(),
  ): void {
    this.clearExpired(sessionId, ttlMs, now);
    const state = this.states.get(sessionId) ?? {
      lastBotDirectedAt: now,
      messages: [],
    };

    state.lastBotDirectedAt = now;
    if (messages.length > 0) {
      state.messages.push(...messages);
    }
    this.states.set(sessionId, state);
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private clearExpired(
    sessionId: string,
    ttlMs?: number,
    now: number = Date.now(),
  ): void {
    const state = this.states.get(sessionId);
    if (!state) return;

    if (
      now - state.lastBotDirectedAt >
      normalizeGroupStructuredHistoryTtl(ttlMs)
    ) {
      this.states.delete(sessionId);
    }
  }
}

export function buildStructuredUserMessages(
  inputs: StructuredUserInput[],
): ChatCompletionMessageParam[] {
  return inputs.map((input) => ({
    role: "user",
    content: formatStructuredUserContent(input),
  }));
}

export function attachImagesToCurrentUserMessages(
  messages: ChatCompletionMessageParam[],
  pendingImageUrls?: string[],
): ChatCompletionMessageParam[] {
  if (
    !pendingImageUrls ||
    pendingImageUrls.length === 0 ||
    messages.length === 0
  ) {
    return messages;
  }

  const nextMessages = [...messages];
  const lastIndex = nextMessages.length - 1;
  const lastMessage = nextMessages[lastIndex];

  if (lastMessage.role !== "user") {
    return nextMessages;
  }

  const textContent =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : extractTextFromContent(lastMessage.content);
  const content: MultimodalContentItem[] = [
    { type: "text", text: textContent || "[No text content]" },
    ...pendingImageUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];

  nextMessages[lastIndex] = {
    role: "user",
    content,
  } as ChatCompletionMessageParam;

  return nextMessages;
}

function extractTextFromContent(
  content: ChatCompletionMessageParam["content"] | null | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || part.type !== "text") return "";
      return part.text;
    })
    .filter(Boolean)
    .join("\n");
}

function formatStructuredUserContent(input: StructuredUserInput): string {
  const lines = [
    "[Group Member Message]",
    `Name: ${input.userName || "unknown"}`,
    `QQ: ${input.userId || 0}`,
    `Time: ${formatTimestamp(input.timestamp)}`,
  ];

  if (input.userRole) {
    lines.push(`Role: ${input.userRole}`);
  }
  if (input.userTitle) {
    lines.push(`Title: ${input.userTitle}`);
  }
  if (input.messageId != null) {
    lines.push(`Message ID: ${input.messageId}`);
  }

  lines.push("Content:");
  lines.push(input.content || "[No text content]");
  return lines.join("\n");
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function normalizeGroupStructuredHistoryTtl(ttlMs?: number): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_GROUP_STRUCTURED_HISTORY_TTL_MS;
  }
  return Math.floor(ttlMs);
}
