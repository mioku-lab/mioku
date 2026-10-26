import type {
  AITool,
  AIService,
  Bot,
  Message,
  MessageInput,
  MiokuContext,
  ReplyOptions,
  SenderInfo,
  SentMessage,
  SkillPermissionRole,
  ToolCallRecord,
} from "mioku";

export type BotRole = "owner" | "admin" | "member";

export type ConstraintStrength = "low" | "medium" | "high";

/** 回复场景，决定提示词里的回复指引 */
export type ReplyContextType = "reply" | "comment" | "idle" | "review" | "poked";

/** 合并回复的多条消息 */
export interface ReviewMessages {
  contents: string[];
  userNames: string[];
  messageIds: string[];
}

export interface ChatSender extends SenderInfo {
  readonly title?: string;
}

/**
 * 触发本轮对话的事件。
 * 真实消息/通知事件都满足它；运行时按目标发起时只合成身份字段。
 */
export interface ChatTurnEvent {
  readonly self_id?: string;
  readonly message_type?: string;
  readonly group_id?: string;
  readonly user_id?: string;
  readonly group_name?: string;
  readonly message_id?: string;
  readonly raw_message?: string;
  readonly time?: number;
  readonly sender?: ChatSender;
  readonly bot?: Bot;
  readonly message?: Message;
  reply?(
    message: MessageInput,
    options?: boolean | ReplyOptions,
  ): Promise<SentMessage>;
}

/** 一轮对话面向的会话 */
export interface ChatTarget {
  readonly selfId: string;
  readonly groupId?: string;
  readonly userId: string;
  /** "group:{groupId}" 或 "personal:{userId}" */
  readonly sessionId: string;
}

export interface EmotionEntryConfig {
  examples: string[];
}

export interface EmotionConfig {
  defaultEmotion: string;
  updateIntervalMs: number;
  emotions: Record<string, EmotionEntryConfig>;
}

/**
 * 回复风格配置
 */
export interface ReplyStyleConfig {
  // 默认回复风格
  baseStyle: string;
  // 特殊回复风格
  multipleStyles: string[];
  // 使用特殊风格的概率 (0-1)
  multipleProbability: number;
}

/**
 * 话题跟踪配置
 */
export interface TopicConfig {
  enabled: boolean;
  // 话题窗口长度（小时），同时也是每个群的检查周期
  windowHours: number;
  // 在提示词中回填多少个历史窗口
  historyWindowCount: number;
}

/**
 * 表情包系统配置
 */
export interface EmojiConfig {
  enabled: boolean;
  characters: string[];
  stickers: string[];
}

/**
 * 表达习惯配置
 *
 * 不再用工作模型总结、也不落库：主对话被触发时直接拉目标用户最近的发言，
 * 从中抽若干条当风格样本注入。sampleSize 同时是拉取条数的上限依据。
 * 详见 humanize/style-samples.ts。
 */
export interface ExpressionConfig {
  enabled: boolean;
  // 从该用户最近多少条发言里挑样本
  lookbackMessages: number;
  // 最多挑几条当样本注入
  sampleSize: number;
}

/**
 * 数据库定期清理配置
 */
export interface RetentionConfig {
  enabled: boolean;
  // 群聊/私聊消息保留时长
  messageRetentionMs: number;
  // 话题摘要保留时长
  topicRetentionMs: number;
  // 媒体/卡片/转发摘要保留时长
  mediaSummaryRetentionMs: number;
  // 图片描述记录保留时长
  imageRetentionMs: number;
  // 群事件保留时长
  eventRetentionMs: number;
  // 清理任务执行间隔
  cleanupIntervalMs: number;
}

/**
 * 动态延迟配置
 * 根据互动人数动态调整回复延迟
 */
export interface DynamicDelayConfig {
  enabled: boolean;
  // 互动窗口 在这个区间内统计群聊活跃程度
  interactionWindowMs: number;
  // 每个人与bot交互后增加的基础延迟
  baseDelayMs: number;
  // 延迟最大上限
  maxDelayMs: number;
}

/**
 * SearXNG 网页搜索配置
 */
export interface SearxngConfig {
  enabled: boolean;
  // 服务器URL
  baseUrl: string;
  // 超时
  timeoutMs: number;
  // 获取的搜索结果的默认上限
  defaultLimit: number;
  // 最大上限
  maxLimit: number;
  // 允许的最大搜索次数
  maxSearchCount: number;
}

/**
 * 网页阅读工具配置
 */
export interface WebReaderConfig {
  enabled: boolean;
  // 是否使用工作模型精简网页结果
  useWorkingModel: boolean;
  // 超时
  timeoutMs: number;
  // 最大网页字节数
  maxHtmlBytes: number;
  // 最大字符数
  maxExtractedChars: number;
  // 浏览器渲染超时
  browserTimeoutMs: number;
  // 允许的网页格式
  allowedContentTypes: string[];
}

/**
 * 语音消息配置
 */
export interface AudioConfig {
  enabled: boolean;
}

export interface AIRequestLimitConfig {
  userRpm: number;
  groupRpm: number;
  windowMs: number;
}

/**
 * 聊天插件配置
 */
export interface ChatConfig {
  /** @deprecated AI 连接已迁移到 ai-service providers */
  apiUrl?: string;
  /** @deprecated AI 连接已迁移到 ai-service providers；非空仅作兼容哨兵 */
  apiKey?: string;
  model: string;
  workingModel: string;
  multimodalWorkingModel: string;
  isMultimodal: boolean;
  enableMediaRecognition: boolean;
  ignorePrivateChat: boolean;
  nicknames: string[];
  persona: string;
  maxContextTokens: number;
  temperature: number;
  searxng: SearxngConfig;
  webReader: WebReaderConfig;
  audio: AudioConfig;
  historyCount: number;
  blacklistGroups: string[];
  whitelistGroups: string[];
  mediaAnalysisBlacklistUsers: string[];
  maxSessions: number;
  maxIterations: number;
  enableExternalSkills: boolean;
  allowedExternalSkills: string[];
  stream: boolean;
  enableTypingDelay: boolean;
  typingDelayMaxTotalMs: number;
  enableMarkdownScreenshot: boolean;
  debug: boolean;
  outputLengthConstraintStrength: ConstraintStrength;
  toolCallConstraintStrength: ConstraintStrength;
  emojiUsageConstraintStrength: ConstraintStrength;
  audioUsageConstraintStrength: ConstraintStrength;
  markdownUsageConstraintStrength: ConstraintStrength;
  groupStructuredHistoryTtlMs: number;
  cooldownAfterReplyMs: number;
  aiRequestLimits: AIRequestLimitConfig;
  dynamicDelay: DynamicDelayConfig;
  emotion: EmotionConfig;
  replyStyle: ReplyStyleConfig;
  topic: TopicConfig;
  emoji: EmojiConfig;
  expression: ExpressionConfig;
  retention: RetentionConfig;
}

/**
 * 每群单独的开关覆盖
 * 不填写的开关回退到全局默认；私聊会话不使用此覆盖
 */
export interface ChatGroupOverrides {
  emoji?: { enabled?: boolean };
  expression?: { enabled?: boolean };
  retention?: { enabled?: boolean };
  topic?: { enabled?: boolean };
  audio?: { enabled?: boolean };
  searxng?: { enabled?: boolean };
  webReader?: { enabled?: boolean };
  dynamicDelay?: { enabled?: boolean };
  enableMarkdownScreenshot?: boolean;
  enableMediaRecognition?: boolean;
  allowedExternalSkills?: string[];
}

export type ChatGroupsFile = {
  groups: Record<string, ChatGroupOverrides>;
};

/** 同步取配置；传 groupId 时合并该群覆盖 */
export type ChatConfigProvider = (groupId?: string) => ChatConfig;

/**
 * 会话类型
 */
export type SessionType = "group" | "personal";

/**
 * 会话元数据
 */
export interface SessionMeta {
  id: string; // "group:{group_id}" 或 "personal:{user_id}"
  type: SessionType;
  targetId: string; // group_id 或 user_id
  createdAt: number;
  updatedAt: number;
  compressedContext: string | null;
}

/**
 * 聊天消息记录
 */
export interface ChatMessage {
  id?: number;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string; // 存储时统一为字符串
  userId?: string;
  userName?: string;
  userRole?: string; // "owner" | "admin" | "member"
  userTitle?: string;
  groupId?: string;
  groupName?: string;
  timestamp: number;
  messageId?: string; // 消息 id
}

/**
 * 触发消息
 */
export interface TargetMessage {
  userName: string;
  userId: string;
  userRole: string;
  userTitle?: string;
  content: string;
  messageId?: string;
  timestamp: number;
  quote?: QuoteInfo;
}

export interface QuoteInfo {
  messageId: string;
  senderName?: string;
  senderId?: string;
  content?: string;
  fromBot: boolean;
}

/**
 * 技能会话（per group session）
 */
export interface SkillSession {
  skillName: string;
  tools: Map<string, AITool>;
  loadedAt: number;
  expiresAt: number; // loadedAt + 1h
}

/**
 * 工具上下文
 */
export interface ToolContext {
  ctx: MiokuContext;
  event?: ChatTurnEvent;
  sessionId: string;
  groupId?: string;
  userId: string;
  triggerSkillRole: SkillPermissionRole;
  config: ChatConfig;
  aiService: AIService;
  /** AI 每产出一条文本就立即发送（流式） */
  onTextContent?: (
    text: string,
    messageIndex: number,
    totalMessages: number,
  ) => void | Promise<void>;
  /** 已经由 onTextContent 发出的消息下标 */
  sentMessageIndices?: Set<number>;
  /** 附到本轮主模型请求的图片 */
  pendingImageUrls?: string[];
}

/**
 * 聊天结果
 */
export interface ChatResult {
  messages: string[];
  toolCalls: ToolCallRecord[];
  emojiPath: string | null;
  protocolMessages: unknown[];
}

/**
 * 话题记录
 */
export interface TopicRecord {
  id?: number;
  sessionId: string;
  title: string;
  keywords: string; // JSON array
  summary: string;
  messageCount: number;
  windowStartAt?: number;
  windowEndAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 群事件记录（撤回 / 进退群 / 拍一拍）
 */
export type GroupEventKind =
  | "recall"
  | "member_increase"
  | "member_decrease"
  | "poke";

export interface GroupEventRecord {
  id?: number;
  groupId: string;
  kind: GroupEventKind;
  /** 事件主体 */
  userId?: string;
  userName?: string;
  /** 事件客体 */
  targetId?: string;
  targetName?: string;
  /** 撤回事件里被撤回的消息 id：用来把标记贴回聊天记录 */
  messageId?: string;
  /** 事件正文 */
  content?: string;
  /** 平台事件 id，用于去重 */
  eventKey?: string;
  timestamp: number;
}

/** 注入用的事件感知结果，由 manage/group-events.ts 渲染 */
export interface GroupEventContexts {
  /** 进退群、拍一拍等动作，直接写进 prompt */
  eventContext?: string;
  /** messageId -> 撤回标记，渲染聊天记录时贴在对应消息后面 */
  recallMarks?: Map<string, string>;
}

/**
 * 图片记录
 */
export interface ImageRecord {
  id?: number;
  hash: string; // 图片哈希
  url: string; // 原始 URL
  type: "image";
  description: string; // AI 生成的简要描述
  createdAt: number;
}

export type MediaSummaryKind = "video" | "forward" | "card" | "notice";

export interface MediaSummaryRecord {
  id?: number;
  key: string;
  kind: MediaSummaryKind;
  source: string;
  summary: string;
  createdAt: number;
}
