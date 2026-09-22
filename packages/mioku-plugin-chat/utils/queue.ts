import type { ChatConfig, TargetMessage } from "../types";

/**
 * 等待处理的队列消息
 */
export interface QueuedMessage {
  event: any;
  config: ChatConfig;
  triggerReason?: string;
  queuedAt: number;
}

/**
 * 消息队列管理器
 * 处理群级别的 AI 请求队列，确保一个群只有一个 AI 在思考
 */
export class MessageQueueManager {
  private pendingMessages = new Map<string, QueuedMessage[]>();
  private activeTargetMessages = new Map<string, TargetMessage>();

  /**
   * 将消息加入队列
   */
  enqueue(
    groupSessionId: string,
    event: any,
    config: ChatConfig,
    triggerReason?: string,
  ): void {
    const queue = this.pendingMessages.get(groupSessionId) ?? [];
    queue.push({ event, config, triggerReason, queuedAt: Date.now() });
    this.pendingMessages.set(groupSessionId, queue);
  }

  /**
   * 获取队列长度
   */
  getQueueLength(groupSessionId: string): number {
    return this.pendingMessages.get(groupSessionId)?.length ?? 0;
  }

  /**
   * 检查群是否正在处理
   */
  isProcessing(groupSessionId: string): boolean {
    return this.activeTargetMessages.has(groupSessionId);
  }

  /**
   * 设置活跃的 targetMessage
   */
  setActiveTarget(groupSessionId: string, target: TargetMessage): void {
    this.activeTargetMessages.set(groupSessionId, target);
  }

  /**
   * 获取活跃的 targetMessage
   */
  getActiveTarget(groupSessionId: string): TargetMessage | undefined {
    return this.activeTargetMessages.get(groupSessionId);
  }

  /**
   * 清理活跃的 targetMessage
   */
  clearActiveTarget(groupSessionId: string): void {
    this.activeTargetMessages.delete(groupSessionId);
  }

  /**
   * 获取队列（用于处理）
   */
  getQueue(groupSessionId: string): QueuedMessage[] | undefined {
    return this.pendingMessages.get(groupSessionId);
  }

  /**
   * 清空队列
   */
  clearQueue(groupSessionId: string): void {
    this.pendingMessages.delete(groupSessionId);
  }

  /**
   * 检查是否有队列
   */
  hasQueue(groupSessionId: string): boolean {
    const queue = this.pendingMessages.get(groupSessionId);
    return !!queue && queue.length > 0;
  }

  dispose(): void {
    this.pendingMessages.clear();
    this.activeTargetMessages.clear();
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
