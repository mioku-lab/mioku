import type { MiokiContext } from "mioki";
import type { AIInstance, AIService } from "../../src/services/ai/types";
import type { ChatConfig } from "./types";
import type { ChatDatabase } from "./db";
import type { HumanizeEngine } from "./humanize";
import type { SessionManager } from "./manage/session";
import type { SkillSessionManager } from "./manage/skill-session";
import type { RateLimiter } from "./manage/rate-limiter";
import type { MessageQueueManager } from "./utils/queue";
import type { GroupStructuredHistoryManager } from "./manage/group-structured-history";
import type { CooldownManager } from "./manage/cooldown";
import type { IdleCheckManager } from "./manage/idle-check";
import type { QueueProcessor } from "./manage/queue-processor";
import type {
  RunRateLimitGuard,
  GetGroupHistoryMessages,
  GetGroupInfoData,
  GetHumanizeContexts,
  SendAIResponse,
  SendMessage,
  SaveBotMessages,
  SendEmoji,
  BuildToolContext,
  HistoryMediaOptions,
  BuildStructuredUserInputFromTarget,
  RunChat,
} from "./manage/types";

/**
 * Core plugin context - bundles all managers and core services.
 * This is created once during plugin setup and used throughout the plugin lifetime.
 */
export interface ChatPluginContext {
  // Core context
  ctx: MiokiContext;
  config: ChatConfig;
  db: ChatDatabase;
  aiInstance: AIInstance;
  aiService: AIService;
  humanize: HumanizeEngine;

  // Managers
  sessionManager: SessionManager;
  skillManager: SkillSessionManager;
  rateLimiter: RateLimiter;
  queueManager: MessageQueueManager;
  groupStructuredHistory: GroupStructuredHistoryManager;
  cooldownManager: CooldownManager;
  idleCheckManager: IdleCheckManager;
  queueProcessor: QueueProcessor;

  // Utility
  runWithRateLimitGuard: RunRateLimitGuard;

  // Services (utility functions)
  buildHistoryMediaOptions: (
    ai: AIInstance,
    config: ChatConfig,
  ) => HistoryMediaOptions;
  getGroupHistoryMessages: GetGroupHistoryMessages;
  getGroupInfoData: GetGroupInfoData;
  getHumanizeContexts: GetHumanizeContexts;
  sendAIResponse: SendAIResponse;
  sendMessage: SendMessage;
  saveBotMessages: SaveBotMessages;
  sendEmoji: SendEmoji;
  buildToolContext: BuildToolContext;
  buildStructuredUserInputFromTarget: BuildStructuredUserInputFromTarget;
  runChat: RunChat;
}

/**
 * Runtime state for rate limiting - passed separately as it's mutable state.
 */
export interface ChatRuntime {
  isRateLimitBlocked: () => boolean;
  processingSet: Set<string>;
}
