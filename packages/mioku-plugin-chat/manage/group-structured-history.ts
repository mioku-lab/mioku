import type { ChatTurnEvent } from "../types";
import {
  contentText,
  imagePart,
  textPart,
  type ChatCompletionMessageParam,
} from "../core/model-content";
import { senderTitle } from "../utils/sender";

export interface StructuredUserInput {
  userName: string;
  userId: string;
  userRole?: string;
  userTitle?: string;
  content: string;
  messageId?: string;
  timestamp: number;
}

interface GroupStructuredHistoryState {
  lastBotDirectedAt: number;
  messages: ChatCompletionMessageParam[];
}

const DEFAULT_GROUP_STRUCTURED_HISTORY_TTL_MS = 10 * 60_000;
const MAX_GROUP_STRUCTURED_HISTORY_MESSAGES = 80;

function trimStructuredHistory(messages: ChatCompletionMessageParam[]): void {
  if (messages.length <= MAX_GROUP_STRUCTURED_HISTORY_MESSAGES) return;
  let start = messages.length - MAX_GROUP_STRUCTURED_HISTORY_MESSAGES;
  // 避免拆开工具调用
  while (start < messages.length && messages[start].role !== "user") start++;
  messages.splice(0, start);
}

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
    const state = this.states.get(sessionId);
    if (!state || messages.length === 0) return;

    state.messages.push(...messages);
    trimStructuredHistory(state.messages);
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

export function buildStructuredUserInputFromEvent(
  event: ChatTurnEvent,
  content: string,
  fallbackTimestamp: number = Date.now(),
): StructuredUserInput {
  const userId = String(event.user_id || event.sender?.user_id || "");
  return {
    userName: event.sender?.card || event.sender?.nickname || userId || "0",
    userId,
    userRole: event.sender?.role || "member",
    userTitle: senderTitle(event.sender),
    content,
    messageId: event.message_id,
    timestamp: typeof event.time === "number" ? event.time : fallbackTimestamp,
  };
}

/** 目标消息或入库消息转成结构化输入 */
export function structuredInputOf(msg: {
  userName?: string;
  userId?: string;
  userRole?: string;
  userTitle?: string;
  content: string;
  messageId?: string;
  timestamp: number;
}): StructuredUserInput {
  return {
    userName: msg.userName ?? "",
    userId: msg.userId ?? "",
    userRole: msg.userRole,
    userTitle: msg.userTitle,
    content: msg.content,
    messageId: msg.messageId,
    timestamp: msg.timestamp,
  };
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
      : contentText(lastMessage.content);

  nextMessages[lastIndex] = {
    role: "user",
    content: [
      textPart(textContent || "[No text content]"),
      ...pendingImageUrls.map((url) => imagePart(url)),
    ],
  };

  return nextMessages;
}

function formatStructuredUserContent(input: StructuredUserInput): string {
  const lines = [
    "[Group Member Message]",
    `Name: ${input.userName || "unknown"}`,
    `user_id: ${input.userId || "unknown"}`,
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
