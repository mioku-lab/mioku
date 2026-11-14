import type { Logger, MessageEvent } from "mioku";
import type { RateLimiter } from "./rate-limiter";
import type { SessionTurnScheduler } from "./session-turn-scheduler";
import { toPendingGroupMessage, type PendingGroupMessage } from "./cooldown";

export interface DynamicDelayBatch {
  groupSessionId: string;
  groupId: string;
  selfId: string;
  messages: PendingGroupMessage[];
}

interface DynamicDelayQueueData {
  messages: PendingGroupMessage[];
  timer: NodeJS.Timeout | null;
  delayUntil: number;
}

export interface QueueProcessorOptions {
  scheduler: SessionTurnScheduler;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** 动态延迟到期，已在会话串行队列里 */
  onDynamicDelay: (batch: DynamicDelayBatch) => Promise<void>;
  /** 会话忙时排队的消息轮到处理，已在会话串行队列里 */
  onQueued: (groupSessionId: string, selfId: string) => Promise<void>;
}

/** 动态延迟与忙时排队的调度 */
export class QueueProcessor {
  private dynamicDelayQueues = new Map<string, DynamicDelayQueueData>();

  constructor(private readonly opts: QueueProcessorOptions) {}

  collectDynamicDelayMessage(
    groupSessionId: string,
    event: MessageEvent,
    content: string,
  ): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = { messages: [], timer: null, delayUntil: 0 };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    queueData.messages.push(toPendingGroupMessage(event, content));
  }

  startDynamicDelayTimer(
    groupSessionId: string,
    groupId: string,
    delayMs: number,
    selfId: string,
  ): void {
    let queueData = this.dynamicDelayQueues.get(groupSessionId);
    if (!queueData) {
      queueData = {
        messages: [],
        timer: null,
        delayUntil: Date.now() + delayMs,
      };
      this.dynamicDelayQueues.set(groupSessionId, queueData);
    }
    if (queueData.timer) clearTimeout(queueData.timer);
    queueData.delayUntil = Date.now() + delayMs;

    this.opts.logger.info(
      `[DynamicDelay] group ${groupId} start delay ${delayMs / 1000}s, interactions: ${this.opts.rateLimiter.getInteractionCount(groupId)}`,
    );

    const timer = setTimeout(() => {
      const current = this.dynamicDelayQueues.get(groupSessionId);
      if (!current || current !== queueData || current.timer !== timer) return;
      this.dynamicDelayQueues.delete(groupSessionId);
      current.timer = null;
      if (current.messages.length === 0) return;

      const batch: DynamicDelayBatch = {
        groupSessionId,
        groupId,
        selfId,
        messages: current.messages,
      };
      void this.opts.scheduler
        .run(groupSessionId, "dynamic-delay", () =>
          this.opts.onDynamicDelay(batch),
        )
        .catch((err) =>
          this.opts.logger.error(
            `[DynamicDelay] group ${groupId} processing failed: ${err}`,
          ),
        );
    }, delayMs);
    queueData.timer = timer;
  }

  isInDynamicDelay(groupSessionId: string): boolean {
    const queue = this.dynamicDelayQueues.get(groupSessionId);
    return queue != null && Date.now() < queue.delayUntil;
  }

  scheduleQueuedMessages(groupSessionId: string, selfId: string): void {
    void this.opts.scheduler
      .run(
        groupSessionId,
        "queued-message",
        () => this.opts.onQueued(groupSessionId, selfId),
        { dedupeKey: `queued-message:${selfId}` },
      )
      .catch((err) =>
        this.opts.logger.error(
          `[Queue] group ${groupSessionId} scheduling failed: ${err}`,
        ),
      );
  }

  dispose(): void {
    for (const queue of this.dynamicDelayQueues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.dynamicDelayQueues.clear();
  }
}
