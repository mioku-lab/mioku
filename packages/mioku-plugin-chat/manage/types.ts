import type { MiokiContext } from "mioki";
import type { AIInstance, AIService } from "mioku";
import type { SkillPermissionRole } from "mioku";
import type { ChatRuntimePromptInjection } from "mioku";
import type { ChatConfig, ChatMessage, TargetMessage, ToolContext, ChatResult } from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import type { EmojiAgent } from "../humanize";
import type { SkillSessionManager } from "./skill-session";
import type { GroupStructuredHistoryManager, StructuredUserInput } from "./group-structured-history";
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
  opts?: { userId?: number; groupId?: number; label?: string },
) => Promise<T | null>;

export type GetGroupHistoryMessages = (
  groupId: number,
  groupSessionId: string,
  ctx: MiokiContext,
  historyCount: number,
  db: ChatDatabase,
  selfId: number,
  mediaOptions?: HistoryMediaOptions,
) => Promise<{ history: ChatMessage[] }>;

export type GetGroupInfoData = (
  ctx: MiokiContext,
  groupId: number,
  selfId: number,
  fallbackGroupName?: string,
) => Promise<GroupInfoResult>;

export type GetHumanizeContexts = (
  humanize: HumanizeEngine,
  groupSessionId: string,
  userName: string,
  history: ChatMessage[],
  triggerUserId?: number,
) => Promise<HumanizeContextsResult>;

export type SendAIResponse = (options: SendAIResponseOptions, selfId: number) => Promise<void>;

export type SaveBotMessages = (
  groupId: number,
  groupSessionId: string,
  messages: string[],
  timestamp: number,
  config: ChatConfig,
  db: ChatDatabase,
  ctx: MiokiContext,
  selfId: number,
) => void;

export type SendEmoji = (ctx: MiokiContext, groupId: number, emojiPath: string | null | undefined, selfId: number) => Promise<void>;

export type SendMessage = (
  ctx: MiokiContext,
  groupId: number | undefined,
  userId: number,
  text: string,
  config: ChatConfig,
  selfId: number,
) => Promise<void>;

export type BuildToolContext = (options: {
  ctx: MiokiContext;
  event: any;
  selfId: number;
  groupSessionId: string;
  groupId?: number;
  userId: number;
  config: ChatConfig;
  aiService: AIService;
  db: ChatDatabase;
  botRole: "owner" | "admin" | "member";
  pendingImageUrls?: string[];
  humanize: HumanizeEngine;
  targetMessage: TargetMessage;
}) => ToolContext;

export type BuildStructuredUserInput = (event: any, content: string, fallbackTimestamp?: number) => StructuredUserInput;

export type BuildStructuredUserInputFromTarget = (targetMessage: TargetMessage) => StructuredUserInput;

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
    messageIds: number[];
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