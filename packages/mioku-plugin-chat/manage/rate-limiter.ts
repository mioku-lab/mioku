import type { AIRequestLimitConfig, ChatConfig, DynamicDelayConfig } from "../types";

const DEFAULT_DYNAMIC_DELAY: DynamicDelayConfig = {
  enabled: true,
  interactionWindowMs: 60_000,
  baseDelayMs: 30_000,
  maxDelayMs: 300_000,
};

const DEFAULT_AI_REQUEST_LIMITS: AIRequestLimitConfig = {
  userRpm: 3,
  groupRpm: 6,
  windowMs: 60_000,
};

export type ChatConfigProvider = (groupId?: string) => ChatConfig;

export class RateLimiter {
  private userTriggers: Map<string, number[]> = new Map();
  private userMessages: Map<string, { content: string; timestamp: number }[]> =
    new Map();
  private groupLastResponse: Map<string, number> = new Map();
  private groupInteractions: Map<string, Map<string, number[]>> = new Map();
  private userAiRequests: Map<string, number[]> = new Map();
  private groupAiRequests: Map<string, number[]> = new Map();

  private readonly maxTriggersPerWindow: number;
  private readonly windowMs: number;
  private readonly dedupWindowMs: number;
  private readonly groupCooldownMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private getConfig: ChatConfigProvider;
  private getQueueLengthFn: ((groupId: string) => number) | null = null;

  setConfigProvider(provider: ChatConfigProvider): void {
    this.getConfig = provider;
  }

  setQueueLengthGetter(fn: (groupId: string) => number): void {
    this.getQueueLengthFn = fn;
  }

  constructor(options?: {
    maxTriggersPerWindow?: number;
    windowMs?: number;
    dedupWindowMs?: number;
    groupCooldownMs?: number;
  }) {
    this.maxTriggersPerWindow = options?.maxTriggersPerWindow ?? 5;
    this.windowMs = options?.windowMs ?? 60_000;
    this.dedupWindowMs = options?.dedupWindowMs ?? 30_000;
    this.groupCooldownMs = options?.groupCooldownMs ?? 1_000;
    this.getConfig = () => ({
      dynamicDelay: DEFAULT_DYNAMIC_DELAY,
      aiRequestLimits: DEFAULT_AI_REQUEST_LIMITS,
    }) as unknown as ChatConfig;

    this.cleanupTimer = setInterval(() => this.cleanup(), 300_000);
  }

  private getDynamicDelay(groupId?: string): DynamicDelayConfig {
    return this.getConfig(groupId)?.dynamicDelay ?? DEFAULT_DYNAMIC_DELAY;
  }

  private getAiRequestLimits(groupId?: string): AIRequestLimitConfig {
    return this.getConfig(groupId)?.aiRequestLimits ?? DEFAULT_AI_REQUEST_LIMITS;
  }

  canProcess(
    userId: string,
    groupId: string | undefined,
    content: string,
  ): boolean {
    const now = Date.now();

    if (groupId) {
      const lastResponse = this.groupLastResponse.get(groupId);
      if (lastResponse && now - lastResponse < this.groupCooldownMs) {
        return false;
      }
    }

    const triggers = this.userTriggers.get(userId) ?? [];
    const recentTriggers = triggers.filter((t) => now - t < this.windowMs);
    if (recentTriggers.length >= this.maxTriggersPerWindow) {
      return false;
    }

    const messages = this.userMessages.get(userId) ?? [];
    const recentSame = messages.find(
      (m) => m.content === content && now - m.timestamp < this.dedupWindowMs,
    );
    return !recentSame;
  }

  record(userId: string, groupId: string | undefined, content: string): void {
    const now = Date.now();

    const triggers = this.userTriggers.get(userId) ?? [];
    triggers.push(now);
    this.userTriggers.set(userId, triggers);

    const messages = this.userMessages.get(userId) ?? [];
    messages.push({ content, timestamp: now });
    if (messages.length > 3) messages.shift();
    this.userMessages.set(userId, messages);

    if (groupId) {
      this.groupLastResponse.set(groupId, now);
    }
  }

  recordInteraction(groupId: string, userId: string): void {
    const dynamicDelay = this.getDynamicDelay(groupId);
    if (!dynamicDelay.enabled) return;

    const now = Date.now();
    const windowMs = dynamicDelay.interactionWindowMs;

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

  canRunAIRequest(userId?: string, groupId?: string): boolean {
    const now = Date.now();
    const { userRpm, groupRpm, windowMs } = this.getAiRequestLimits(groupId);

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

  recordAIRequest(userId?: string, groupId?: string): void {
    const now = Date.now();
    const { windowMs } = this.getAiRequestLimits(groupId);

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

  getInteractionCount(groupId: string): number {
    const now = Date.now();
    const { interactionWindowMs: windowMs } = this.getDynamicDelay(groupId);

    if (this.getQueueLengthFn) {
      const queueLength = this.getQueueLengthFn(groupId);
      if (queueLength > 0) {
        return queueLength;
      }
    }

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

  calculateDelay(groupId: string): number {
    const dynamicDelay = this.getDynamicDelay(groupId);
    if (!dynamicDelay.enabled) return 0;

    const interactionCount = this.getInteractionCount(groupId);
    if (interactionCount <= 1) return 0;

    const { baseDelayMs, maxDelayMs } = dynamicDelay;
    const delay = (interactionCount - 1) * baseDelayMs;
    return Math.min(delay, maxDelayMs);
  }

  getDelayInfo(groupId: string): {
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

  clearGroupInteractions(groupId: string): void {
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

    for (const [groupId, groupUsers] of this.groupInteractions) {
      const windowMs = this.getDynamicDelay(groupId).interactionWindowMs;
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