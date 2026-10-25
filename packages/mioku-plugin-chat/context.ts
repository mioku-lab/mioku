import type {
  AIInstance,
  AIModelRole,
  AIService,
  MiokuContext,
} from "mioku";
import type { AudioServiceApi } from "mioku-service-audio";
import type { ChatConfig, ChatConfigProvider } from "./types";
import type { ChatDatabase } from "./db";
import type { HumanizeEngine } from "./humanize";
import type { SessionManager } from "./manage/session";
import type { SkillSessionManager } from "./manage/skill-session";
import type { RateLimiter } from "./manage/rate-limiter";
import type { RateLimitGuard } from "./manage/rate-limit-guard";
import type { MessageQueueManager } from "./utils/queue";
import type { GroupStructuredHistoryManager } from "./manage/group-structured-history";
import type { CooldownManager } from "./manage/cooldown";
import type { GroupEventPerception } from "./manage/group-events";
import type { QueueProcessor } from "./manage/queue-processor";
import type { SessionTurnScheduler } from "./manage/session-turn-scheduler";

export type RunRateLimitGuard = RateLimitGuard["run"];

/** 插件级共享的服务与状态管理器 */
export interface ChatPluginContext {
  ctx: MiokuContext;
  configProvider: ChatConfigProvider;
  getConfig: (groupId?: string) => Promise<ChatConfig>;
  db: ChatDatabase;
  aiService: AIService;
  /** 主模型 */
  aiInstance: AIInstance;
  visionAIInstance: AIInstance;
  getAIInstance: (role?: AIModelRole) => AIInstance | undefined;
  humanize: HumanizeEngine;
  audioService?: AudioServiceApi;

  sessionManager: SessionManager;
  skillManager: SkillSessionManager;
  rateLimiter: RateLimiter;
  queueManager: MessageQueueManager;
  groupStructuredHistory: GroupStructuredHistoryManager;
  groupEvents: GroupEventPerception;
  cooldownManager: CooldownManager;
  queueProcessor: QueueProcessor;
  sessionTurnScheduler: SessionTurnScheduler;
  runWithRateLimitGuard: RunRateLimitGuard;
}

export interface ChatRuntimeState {
  isRateLimitBlocked: () => boolean;
  processingSet: Set<string>;
}

export interface ChatHandlerState {
  getConfig: (groupId?: string) => Promise<ChatConfig>;
  matchMessageCommands?: (
    text: string,
  ) => Array<{ plugin: string; command: string }>;
  runtimeState: ChatRuntimeState;
  pokeCooldowns: Map<string, number>;
}
