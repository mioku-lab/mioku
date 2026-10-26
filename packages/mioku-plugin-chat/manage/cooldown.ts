import type { Logger, MessageEvent } from "mioku";
import type { ChatConfigProvider } from "../types";
import type { SessionTurnScheduler } from "./session-turn-scheduler";
import { eventUserId, senderName } from "../utils/sender";

const DEFAULT_COOLDOWN_MS = 20_000;

/** 冷却期间收集的群消息 */
export interface PendingGroupMessage {
  event: MessageEvent;
  content: string;
  userName: string;
  userId: string;
  messageId: string;
  timestamp: number;
}

export interface CooldownMessage extends PendingGroupMessage {
  isDirectAt: boolean;
}

export interface CooldownBatch {
  groupSessionId: string;
  groupId: string;
  selfId: string;
  messages: CooldownMessage[];
}

export function toPendingGroupMessage(
  event: MessageEvent,
  content: string,
): PendingGroupMessage {
  return {
    event,
    content,
    userName: senderName(event, String(event.user_id)),
    userId: eventUserId(event),
    messageId: String(event.message_id ?? ""),
    timestamp: Date.now(),
  };
}

export interface CooldownManagerOptions {
  scheduler: SessionTurnScheduler;
  configProvider: ChatConfigProvider;
  logger: Logger;
  /** 冷却结束且期间有人说话时调用，已在会话串行队列里 */
  onExpire: (batch: CooldownBatch) => Promise<void>;
}

/** 机器人回复后的冷却窗口：期间的消息攒起来，结束后一次性回顾 */
export class CooldownManager {
  private groupCooldownUntil = new Map<string, number>();
  private groupCooldownMessages = new Map<string, CooldownMessage[]>();
  private cooldownTimeoutIds = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: CooldownManagerOptions) {}

  startCooldownTimer(
    groupSessionId: string,
    groupId: string,
    selfId: string,
  ): void {
    const existingTimer = this.cooldownTimeoutIds.get(groupSessionId);
    if (existingTimer) clearTimeout(existingTimer);

    const cooldownMs =
      this.opts.configProvider(groupId).cooldownAfterReplyMs ??
      DEFAULT_COOLDOWN_MS;

    const timer = setTimeout(() => {
      if (this.cooldownTimeoutIds.get(groupSessionId) !== timer) return;
      this.cooldownTimeoutIds.delete(groupSessionId);
      this.groupCooldownUntil.delete(groupSessionId);
      const messages = this.groupCooldownMessages.get(groupSessionId) || [];
      this.groupCooldownMessages.delete(groupSessionId);
      if (messages.length === 0) return;

      const batch: CooldownBatch = { groupSessionId, groupId, selfId, messages };
      void this.opts.scheduler
        .run(groupSessionId, "cooldown", () => this.opts.onExpire(batch))
        .catch((err) =>
          this.opts.logger.error(
            `[Cooldown] Group ${groupId} processing failed: ${err}`,
          ),
        );
    }, cooldownMs);

    this.cooldownTimeoutIds.set(groupSessionId, timer);
    this.groupCooldownUntil.set(groupSessionId, Date.now() + cooldownMs);
    if (!this.groupCooldownMessages.has(groupSessionId)) {
      this.groupCooldownMessages.set(groupSessionId, []);
    }
  }

  collectMessage(
    groupSessionId: string,
    event: MessageEvent,
    content: string,
    isDirectAt: boolean,
  ): void {
    const messages = this.groupCooldownMessages.get(groupSessionId) || [];
    messages.push({ ...toPendingGroupMessage(event, content), isDirectAt });
    this.groupCooldownMessages.set(groupSessionId, messages);
  }

  isInCooldown(groupSessionId: string): boolean {
    return Date.now() < (this.groupCooldownUntil.get(groupSessionId) ?? 0);
  }

  dispose(): void {
    for (const timer of this.cooldownTimeoutIds.values()) clearTimeout(timer);
    this.cooldownTimeoutIds.clear();
    this.groupCooldownUntil.clear();
    this.groupCooldownMessages.clear();
  }
}
