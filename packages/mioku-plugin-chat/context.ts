import type { MiokuContext } from "mioku";
import type { AIInstance, AIModelRole, AIService } from "mioku";
import type { ChatConfig } from "./types";
import type { ChatDatabase } from "./db";
import type { HumanizeEngine, ChatConfigProvider } from "./humanize";
import type { SessionManager } from "./manage/session";
import type { SkillSessionManager } from "./manage/skill-session";
import type { RateLimiter } from "./manage/rate-limiter";
import type { MessageQueueManager } from "./utils/queue";
import type { GroupStructuredHistoryManager } from "./manage/group-structured-history";
import type { CooldownManager } from "./manage/cooldown";
import type { IdleCheckManager } from "./manage/idle-check";
import type { QueueProcessor } from "./manage/queue-processor";
import type { SessionTurnScheduler } from "./manage/session-turn-scheduler";
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
import type {
  ChatRuntimeNoticeOptions,
  ChatRuntimeResult,
  ChatRuntimeInformationRequestOptions,
} from "mioku";
import type { AudioServiceApi } from "mioku-service-audio";
import type { ChatMessage } from "./types";

export interface ChatPluginContext {
  ctx: MiokuContext;
  defaultConfig: ChatConfig;
  configProvider: ChatConfigProvider;
  getConfig: (groupId?: string) => Promise<ChatConfig>;
  db: ChatDatabase;
  aiInstance: AIInstance;
  workAIInstance: AIInstance;
  visionAIInstance: AIInstance;
  getAIInstance: (role?: AIModelRole) => AIInstance | undefined;
  aiService: AIService;
  humanize: HumanizeEngine;

  sessionManager: SessionManager;
  skillManager: SkillSessionManager;
  rateLimiter: RateLimiter;
  queueManager: MessageQueueManager;
  groupStructuredHistory: GroupStructuredHistoryManager;
  cooldownManager: CooldownManager;
  idleCheckManager: IdleCheckManager;
  queueProcessor: QueueProcessor;
  sessionTurnScheduler: SessionTurnScheduler;

  runWithRateLimitGuard: RunRateLimitGuard;

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
  startCooldownTimer: (
    groupSessionId: string,
    groupId: string,
    selfId: string,
  ) => void;
  recordGroupMessageForLearning: (
    userMsg: ChatMessage,
    groupSessionId: string,
  ) => Promise<void>;
  audioService?: AudioServiceApi;
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

export interface ChatRuntime {
  generateNotice(
    options: ChatRuntimeNoticeOptions,
  ): Promise<ChatRuntimeResult>;
  requestInformation(
    options: ChatRuntimeInformationRequestOptions,
  ): Promise<ChatRuntimeResult>;
}
