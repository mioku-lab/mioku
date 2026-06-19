import { logger } from "mioki";
import type { ChatDatabase } from "../db";

export interface CleanupConfig {
  enabled: boolean;
  messageRetentionMs: number;
  topicRetentionMs: number;
  mediaSummaryRetentionMs: number;
  imageRetentionMs: number;
  expressionKeepPerUser: number;
  cleanupIntervalMs: number;
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  enabled: true,
  messageRetentionMs: 30 * 24 * 60 * 60 * 1000,
  topicRetentionMs: 90 * 24 * 60 * 60 * 1000,
  mediaSummaryRetentionMs: 30 * 24 * 60 * 60 * 1000,
  imageRetentionMs: 60 * 24 * 60 * 60 * 1000,
  expressionKeepPerUser: 6,
  cleanupIntervalMs: 60 * 60 * 1000,
};

export interface CleanupResult {
  messages: number;
  topics: number;
  mediaSummaries: number;
  images: number;
}

export class ChatDatabaseCleanup {
  private timer: NodeJS.Timeout | null = null;
  private runningPromise: Promise<void> | null = null;

  constructor(
    private db: ChatDatabase,
    private config: CleanupConfig,
  ) {}

  start(): NodeJS.Timeout | null {
    if (!this.config.enabled) return null;
    if (this.timer) return this.timer;

    this.timer = setInterval(() => {
      this.runOnceSafe();
    }, Math.max(60_000, this.config.cleanupIntervalMs));
    return this.timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnceSafe(): void {
    if (this.runningPromise) return;
    this.runningPromise = (async () => {
      try {
        const result = await this.runOnce();
        const total =
          result.messages +
          result.topics +
          result.mediaSummaries +
          result.images;
        if (total > 0) {
          logger.info(
            `[chat-cleanup] pruned messages=${result.messages}, topics=${result.topics}, mediaSummaries=${result.mediaSummaries}, images=${result.images}`,
          );
        }
      } catch (err: unknown) {
        logger.warn(`[chat-cleanup] failed: ${err}`);
      } finally {
        this.runningPromise = null;
      }
    })();
  }

  async runOnce(): Promise<CleanupResult> {
    const now = Date.now();
    const messages = this.db.pruneMessagesOlderThan(
      now - this.config.messageRetentionMs,
    );
    const topics = this.db.pruneTopicsOlderThan(
      now - this.config.topicRetentionMs,
    );
    const mediaSummaries = this.db.pruneMediaSummariesOlderThan(
      now - this.config.mediaSummaryRetentionMs,
    );
    const images = this.db.pruneImagesOlderThan(
      now - this.config.imageRetentionMs,
    );
    return { messages, topics, mediaSummaries, images };
  }
}
