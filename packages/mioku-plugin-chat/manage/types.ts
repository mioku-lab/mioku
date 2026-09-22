import type { Bot, MiokuContext } from "mioku";
import type { AIInstance, AIService } from "mioku";
import type { SkillPermissionRole } from "mioku";
import type { ChatRuntimePromptInjection } from "mioku";
import type {
  ChatConfig,
  ChatMessage,
  TargetMessage,
  ToolContext,
  ChatResult,
} from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import type { EmojiAgent } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type {
  GroupStructuredHistoryManager,
  StructuredUserInput,
} from "./group-structured-history";
import type { SendAIResponseOptions } from "../core/base";
import type { GroupInfoResult, HumanizeContextsResult } from "../core/base";

export type { SendAIResponseOptions, GroupInfoResult, HumanizeContextsResult };

export type HistoryMediaOptions = {
  ai?: AIInstance;
  workingModel?: string;
  multimodalWorkingModel?: string;
};

export type RunRateLimitGuard = <T>(
  request: () => Promise<T>,
  opts?: {
    userId?: string;
    groupId?: string;
    label?: string;
    skipRetryOnRateLimit?: boolean;
  },
) => Promise<T | null>;

export type GetGroupHistoryMessages = (
  groupId: string,
  groupSessionId: string,
  ctx: MiokuContext,
  historyCount: number,
  db: ChatDatabase,
  selfId: string,
  mediaOptions?: HistoryMediaOptions,
) => Promise<{ history: ChatMessage[] }>;

export type GetGroupInfoData = (
  ctx: MiokuContext,
  groupId: string,
  selfId: string,
  fallbackGroupName?: string,
) => Promise<GroupInfoResult>;

export type GetHumanizeContexts = (
  humanize: HumanizeEngine,
  groupSessionId: string,
  userName: string,
  history: ChatMessage[],
  triggerUserId?: string,
) => Promise<HumanizeContextsResult>;

export type SendAIResponse = (
  options: SendAIResponseOptions,
  selfId: string,
) => Promise<Array<string | undefined>>;

export type SaveBotMessages = (
  groupId: string,
  groupSessionId: string,
  messages: string[],
  timestamp: number,
  config: ChatConfig,
  db: ChatDatabase,
  ctx: MiokuContext,
  bot?: Bot,
  sentMessageIds?: Array<string | undefined>,
) => void;

export type SendEmoji = (
  ctx: MiokuContext,
  groupId: string,
  emojiPath: string | null | undefined,
  bot?: import("mioku").Bot,
) => Promise<void>;

export type SendMessage = (
  ctx: MiokuContext,
  groupId: string | undefined,
  userId: string,
  text: string,
  config: ChatConfig,
  selfId: string,
  audioService?: import("mioku-service-audio").AudioServiceApi,
) => Promise<void>;

export type BuildToolContext = (options: {
  ctx: MiokuContext;
  event: any;
  selfId: string;
  groupSessionId: string;
  groupId?: string;
  userId: string;
  config: ChatConfig;
  aiService: AIService;
  db: ChatDatabase;
  botRole: "owner" | "admin" | "member";
  pendingImageUrls?: string[];
  humanize: HumanizeEngine;
  targetMessage: TargetMessage;
  audioService?: import("mioku-service-audio").AudioServiceApi;
}) => ToolContext;

export type BuildStructuredUserInput = (
  event: any,
  content: string,
  fallbackTimestamp?: number,
) => StructuredUserInput;

export type BuildStructuredUserInputFromTarget = (
  targetMessage: TargetMessage,
) => StructuredUserInput;

export type PromptCtxForRunChat = {
  config: ChatConfig;
  groupName?: string;
  memberCount?: number;
  botNickname: string;
  botRole: "owner" | "admin" | "member";
  triggerSkillRole?: SkillPermissionRole;
  aiService: AIService;
  isGroup: boolean;
  memoryContext?: string;
  topicContext?: string;
  expressionContext?: string;
  activeSkillsInfo?: string;
  currentEmotion?: string;
  plannerThoughts?: string;
  replyContext?: {
    type: "reply" | "comment" | "idle" | "review" | "poked";
    targetUser?: string;
    targetMessage?: string;
  };
  reviewMessages?: {
    contents: string[];
    userNames: string[];
    messageIds: string[];
  };
  promptInjections?: ChatRuntimePromptInjection[];
  emojiAgent?: EmojiAgent;
};

export type RunChat = (
  ai: AIInstance,
  toolCtx: ToolContext,
  history: ChatMessage[],
  targetMessage: TargetMessage,
  promptCtx: PromptCtxForRunChat,
  humanize: HumanizeEngine,
  skillManager: SkillSessionManager,
  structuredHistory?: {
    manager: GroupStructuredHistoryManager;
    ttlMs: number;
    currentUserInputs: StructuredUserInput[];
  },
  runtimeOptions?: { extraTools?: any[] },
) => Promise<ChatResult>;
