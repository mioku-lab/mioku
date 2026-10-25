import type { MessageEvent } from "mioku";
import type { ChatConfig } from "../types";

/**
 * 等待处理的队列消息
 */
export interface QueuedMessage {
  event: MessageEvent;
  config: ChatConfig;
  queuedAt: number;
}

/**
 * 会话忙时到达的触发消息，等当前一轮结束后合并处理
 */
export class MessageQueueManager {
  private pendingMessages = new Map<string, QueuedMessage[]>();

  enqueue(groupSessionId: string, event: MessageEvent, config: ChatConfig): void {
    const queue = this.pendingMessages.get(groupSessionId) ?? [];
    queue.push({ event, config, queuedAt: Date.now() });
    this.pendingMessages.set(groupSessionId, queue);
  }

  getQueueLength(groupSessionId: string): number {
    return this.pendingMessages.get(groupSessionId)?.length ?? 0;
  }

  getQueue(groupSessionId: string): QueuedMessage[] | undefined {
    return this.pendingMessages.get(groupSessionId);
  }

  clearQueue(groupSessionId: string): void {
    this.pendingMessages.delete(groupSessionId);
  }

  dispose(): void {
    this.pendingMessages.clear();
  }
}

/**
 * 将包含多个 reply 标记的单行文本拆分为多行
 * 例如 "[reply:1]文字A[reply:2]文字B" → ["[reply:1]文字A", "[reply:2]文字B"]
 */
export function splitByReplyMarkers(line: string): string[] {
  const parts = line.split(/(?=\[reply:[^\]\n]+\])/);
  return parts.filter((p) => p.trim());
}

/**
 * 解析单行文本中的标记，按顺序提取 AT、戳人、引用
 * @param line 要解析的文本
 * @param quoteMode "skip" 跳过引用标记，其他值处理引用
 */
export function parseLineMarkers(
  line: string,
  quoteMode?: "skip",
): {
  cleanText: string;
  atUsers: string[];
  pokeUsers: string[];
  quoteId?: string;
  audioText?: string;
} {
  const atUsers: string[] = [];
  const pokeUsers: string[] = [];
  let quoteId: string | undefined;
  let audioText: string | undefined;

  // 提取 AT 标记
  // 标记里是平台用户 id:QQ 号或 openid 都可能出现
  const atPatterns = [/\[at:([^\]\s]+)\]/g];
  for (const pattern of atPatterns) {
    const matches = [...line.matchAll(pattern)];
    for (const match of matches) {
      const userId = String(match[1]).trim();
      if (userId) atUsers.push(userId);
    }
  }

  // 提取戳人标记
  const pokePatterns = [/\[poke:([^\]\s]+)\]/g];
  for (const pattern of pokePatterns) {
    const matches = [...line.matchAll(pattern)];
    for (const match of matches) {
      const userId = String(match[1]).trim();
      if (userId) pokeUsers.push(userId);
    }
  }

  // 提取引用标记（仅在允许时）
  if (quoteMode !== "skip") {
    const replyPatterns = [/\[reply:([^\]\n]+)\]/g];
    for (const pattern of replyPatterns) {
      const matches = [...line.matchAll(pattern)];
      for (const match of matches) {
        if (quoteId === undefined) {
          const value = match[1].trim();
          if (value) quoteId = value;
        }
      }
    }
  }

  // 提取语音标记（单行只取第一个）
  const audioMatch = line.match(/\[audio:([^\]]+)\]/i);
  if (audioMatch?.[1]) {
    const value = audioMatch[1].trim();
    if (value) {
      audioText = value;
    }
  }

  // 清理标记
  let cleanText = line
    .replace(/\[at:[^\]\s]+\]/g, "")
    .replace(/\[poke:\d+\]/g, "")
    .replace(/\[reply:[^\]\n]+\]/g, "")
    .replace(/\[audio:[^\]]+\]/gi, "")
    .trim();

  return { cleanText, atUsers, pokeUsers, quoteId, audioText };
}
