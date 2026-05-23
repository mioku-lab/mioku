import type { AIRequestLimitConfig, DynamicDelayConfig } from "../types";

export class RateLimiter {
  // 用户触发记录：userId -> timestamp[]
  private userTriggers: Map<number, number[]> = new Map();
  // 用户最近消息：userId -> {content, timestamp}[]
  private userMessages: Map<number, { content: string; timestamp: number }[]> =
    new Map();
  // 群组最后响应时间：groupId -> timestamp
  private groupLastResponse: Map<number, number> = new Map();
  private groupInteractions: Map<number, Map<number, number[]>> = new Map();
  private userAiRequests: Map<number, number[]> = new Map();
  private groupAiRequests: Map<number, number[]> = new Map();

  private readonly maxTriggersPerWindow: number;
  private readonly windowMs: number;
  private readonly dedupWindowMs: number;
  private readonly groupCooldownMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly dynamicDelayConfig: DynamicDelayConfig;
  private readonly aiRequestLimitConfig: AIRequestLimitConfig;
  // 外部注入的队列长度获取函数
  private getQueueLengthFn: ((groupId: number) => number) | null = null;

  /**
   * 设置队列长度获取函数
   */
  setQueueLengthGetter(fn: (groupId: number) => number): void {
    this.getQueueLengthFn = fn;
  }

  constructor(options?: {
    maxTriggersPerWindow?: number;
    windowMs?: number;
    dedupWindowMs?: number;
    groupCooldownMs?: number;
    dynamicDelay?: DynamicDelayConfig;
    aiRequestLimits?: AIRequestLimitConfig;
  }) {
    this.maxTriggersPerWindow = options?.maxTriggersPerWindow ?? 5;
    this.windowMs = options?.windowMs ?? 60_000;
    this.dedupWindowMs = options?.dedupWindowMs ?? 30_000;
    this.groupCooldownMs = options?.groupCooldownMs ?? 1_000;
    this.dynamicDelayConfig = options?.dynamicDelay ?? {
      enabled: true,
      interactionWindowMs: 60_000,
      baseDelayMs: 30_000,
      maxDelayMs: 300_000,
    };
    this.aiRequestLimitConfig = options?.aiRequestLimits ?? {
      userRpm: 3,
      groupRpm: 6,
      windowMs: 60_000,
    };

    this.cleanupTimer = setInterval(() => this.cleanup(), 300_000);
  }

  canProcess(
    userId: number,
    groupId: number | undefined,
    content: string,
  ): boolean {
    const now = Date.now();

    // 群组冷却检查
    if (groupId) {
      const lastResponse = this.groupLastResponse.get(groupId);
      if (lastResponse && now - lastResponse < this.groupCooldownMs) {
        return false;
      }
    }

    // 用户频率检查
    const triggers = this.userTriggers.get(userId) ?? [];
    const recentTriggers = triggers.filter((t) => now - t < this.windowMs);
    if (recentTriggers.length >= this.maxTriggersPerWindow) {
      return false;
    }

    // 重复消息检查
    const messages = this.userMessages.get(userId) ?? [];
    const recentSame = messages.find(
      (m) => m.content === content && now - m.timestamp < this.dedupWindowMs,
    );
    return !recentSame;
  }

  /**
   * 记录已处理的消息
   */
  record(userId: number, groupId: number | undefined, content: string): void {
    const now = Date.now();

    // 记录触发
    const triggers = this.userTriggers.get(userId) ?? [];
    triggers.push(now);
    this.userTriggers.set(userId, triggers);

    // 记录消息（只保留最近 3 条）
    const messages = this.userMessages.get(userId) ?? [];
    messages.push({ content, timestamp: now });
    if (messages.length > 3) messages.shift();
    this.userMessages.set(userId, messages);

    // 记录群组响应
    if (groupId) {
      this.groupLastResponse.set(groupId, now);
    }
  }

  recordInteraction(groupId: number, userId: number): void {
    if (!this.dynamicDelayConfig.enabled) return;

    const now = Date.now();
    const windowMs = this.dynamicDelayConfig.interactionWindowMs;

    let groupUsers = this.groupInteractions.get(groupId);
    if (!groupUsers) {
      groupUsers = new Map();
      this.groupInteractions.set(groupId, groupUsers);
    }

    let timestamps = groupUsers.get(userId) ?? [];
    timestamps = timestamps.filter((t) => now - t < windowMs);
    timestamps.push(now);
    groupUsers.set(userId, timestamps);
  }

  canRunAIRequest(userId?: number, groupId?: number): boolean {
    const now = Date.now();
    const { userRpm, groupRpm, windowMs } = this.aiRequestLimitConfig;

    if (typeof userId === "number") {
      const userRequests = (this.userAiRequests.get(userId) ?? []).filter(
        (timestamp) => now - timestamp < windowMs,
      );
      if (userRequests.length >= userRpm) {
        return false;
      }
    }

    if (typeof groupId === "number") {
      const groupRequests = (this.groupAiRequests.get(groupId) ?? []).filter(
        (timestamp) => now - timestamp < windowMs,
      );
      if (groupRequests.length >= groupRpm) {
        return false;
      }
    }

    return true;
  }

  recordAIRequest(userId?: number, groupId?: number): void {
    const now = Date.now();
    const windowMs = this.aiRequestLimitConfig.windowMs;

    if (typeof userId === "number") {
      const userRequests = (this.userAiRequests.get(userId) ?? []).filter(
        (timestamp) => now - timestamp < windowMs,
      );
      userRequests.push(now);
      this.userAiRequests.set(userId, userRequests);
    }

    if (typeof groupId === "number") {
      const groupRequests = (this.groupAiRequests.get(groupId) ?? []).filter(
        (timestamp) => now - timestamp < windowMs,
      );
      groupRequests.push(now);
      this.groupAiRequests.set(groupId, groupRequests);
    }
  }

  getInteractionCount(groupId: number): number {
    const now = Date.now();
    const windowMs = this.dynamicDelayConfig.interactionWindowMs;

    // 优先使用队列长度作为互动人数计算
    if (this.getQueueLengthFn) {
      const queueLength = this.getQueueLengthFn(groupId);
      if (queueLength > 0) {
        return queueLength;
      }
    }

    // 回退到 groupInteractions 统计
    const groupUsers = this.groupInteractions.get(groupId);
    if (!groupUsers) return 0;

    let count = 0;
    for (const [, timestamps] of groupUsers) {
      const recentTimestamps = timestamps.filter((t) => now - t < windowMs);
      if (recentTimestamps.length > 0) {
        count++;
      }
    }
    return count;
  }

  calculateDelay(groupId: number): number {
    if (!this.dynamicDelayConfig.enabled) return 0;

    const interactionCount = this.getInteractionCount(groupId);
    if (interactionCount <= 1) return 0;

    const { baseDelayMs, maxDelayMs } = this.dynamicDelayConfig;
    const delay = (interactionCount - 1) * baseDelayMs;
    return Math.min(delay, maxDelayMs);
  }

  getDelayInfo(groupId: number): {
    delayMs: number;
    interactionCount: number;
    shouldDelay: boolean;
  } {
    const interactionCount = this.getInteractionCount(groupId);
    const delayMs = this.calculateDelay(groupId);
    return {
      delayMs,
      interactionCount,
      shouldDelay: delayMs > 0,
    };
  }

  clearGroupInteractions(groupId: number): void {
    this.groupInteractions.delete(groupId);
  }

  cleanup(): void {
    const now = Date.now();

    for (const [userId, triggers] of this.userTriggers) {
      const valid = triggers.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.userTriggers.delete(userId);
      } else {
        this.userTriggers.set(userId, valid);
      }
    }

    for (const [userId, messages] of this.userMessages) {
      const valid = messages.filter(
        (m) => now - m.timestamp < this.dedupWindowMs,
      );
      if (valid.length === 0) {
        this.userMessages.delete(userId);
      } else {
        this.userMessages.set(userId, valid);
      }
    }

    for (const [groupId, timestamp] of this.groupLastResponse) {
      if (now - timestamp > this.groupCooldownMs * 10) {
        this.groupLastResponse.delete(groupId);
      }
    }

    const aiWindowMs = this.aiRequestLimitConfig.windowMs;
    for (const [userId, requests] of this.userAiRequests) {
      const valid = requests.filter(
        (timestamp) => now - timestamp < aiWindowMs,
      );
      if (valid.length === 0) {
        this.userAiRequests.delete(userId);
      } else {
        this.userAiRequests.set(userId, valid);
      }
    }

    for (const [groupId, requests] of this.groupAiRequests) {
      const valid = requests.filter(
        (timestamp) => now - timestamp < aiWindowMs,
      );
      if (valid.length === 0) {
        this.groupAiRequests.delete(groupId);
      } else {
        this.groupAiRequests.set(groupId, valid);
      }
    }

    if (this.dynamicDelayConfig.enabled) {
      const windowMs = this.dynamicDelayConfig.interactionWindowMs;
      for (const [groupId, groupUsers] of this.groupInteractions) {
        let hasActiveUser = false;
        for (const [userId, timestamps] of groupUsers) {
          const valid = timestamps.filter((t) => now - t < windowMs);
          if (valid.length === 0) {
            groupUsers.delete(userId);
          } else {
            groupUsers.set(userId, valid);
            hasActiveUser = true;
          }
        }
        if (!hasActiveUser) {
          this.groupInteractions.delete(groupId);
        }
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.userTriggers.clear();
    this.userMessages.clear();
    this.groupLastResponse.clear();
    this.groupInteractions.clear();
    this.userAiRequests.clear();
    this.groupAiRequests.clear();
  }
}
