import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MiokiContext } from "mioki";
import type { AITool, SkillPermissionRole } from "../../src";
import type { ChatDatabase } from "./db";

/**
 * 人格状态配置
 */
export interface PersonalityConfig {
  // 状态列表
  states: string[];
  // 切换到其他状态的概率 (0-1)
  stateProbability: number;
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
 * 记忆检索配置
 */
export interface MemoryConfig {
  enabled: boolean;
  // 回忆时拉取的群聊历史条数（通过 message_id 分页）
  groupHistoryLimit: number;
  // 回忆时每个用户历史的默认条数
  userHistoryLimit: number;
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
 * 动作规划器配置
 */
export interface PlannerConfig {
  enabled: boolean;
  // 群聊空闲时间阈值（毫秒）
  idleThresholdMs: number;
  // 群聊记录保底消息数量
  idleMessageCount: number;
  // 空闲检查的 bot ID 列表
  idleCheckBotIds: number[];
}


/**
 * 表情包系统配置
 */
export interface EmojiConfig {
  enabled: boolean;
  // 允许的表情包角色
  characters: string[];
  // 使用AI选择表情包发送
  useAISelection: boolean;
}

/**
 * 表达学习配置
 */
export interface ExpressionConfig {
  enabled: boolean;
  // 单个用户累积多少条消息后触发表达学习
  learnAfterMessages: number;
  // 单个用户最多保留/注入的表达习惯条数
  sampleSize: number;
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
  // 服务器URL
  baseUrl: string;
  // 密钥
  apiKey: string;
  timeoutMs: number;
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
  apiUrl: string;
  apiKey: string;
  model: string;
  workingModel: string;
  multimodalWorkingModel: string;
  isMultimodal: boolean;
  nicknames: string[];
  persona: string;
  maxContextTokens: number;
  temperature: number;
  searxng: SearxngConfig;
  webReader: WebReaderConfig;
  audio: AudioConfig;
  historyCount: number;
  blacklistGroups: number[];
  whitelistGroups: number[];
  mediaAnalysisBlacklistUsers: number[];
  maxSessions: number;
  maxIterations: number;
  enableExternalSkills: boolean;
  allowedExternalSkills: string[];
  stream: boolean;
  enableTypingDelay: boolean;
  typingDelayMaxTotalMs: number;
  enableMarkdownScreenshot: boolean;
  debug: boolean;
  outputLengthConstraintStrength: "low" | "medium" | "high";
  toolCallConstraintStrength: "low" | "medium" | "high";
  emojiUsageConstraintStrength: "low" | "medium" | "high";
  audioUsageConstraintStrength: "low" | "medium" | "high";
  markdownUsageConstraintStrength: "low" | "medium" | "high";
  groupStructuredHistoryTtlMs: number;
  cooldownAfterReplyMs: number;
  aiRequestLimits: AIRequestLimitConfig;
  dynamicDelay: DynamicDelayConfig;
  personality: PersonalityConfig;
  replyStyle: ReplyStyleConfig;
  memory: MemoryConfig;
  topic: TopicConfig;
  planner: PlannerConfig;
  emoji: EmojiConfig;
  expression: ExpressionConfig;
}

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
  targetId: number; // group_id 或 user_id
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
  userId?: number;
  userName?: string;
  userRole?: string; // "owner" | "admin" | "member"
  userTitle?: string;
  groupId?: number;
  groupName?: string;
  timestamp: number;
  messageId?: number; // QQ message_id
}

/**
 * 触发消息
 */
export interface TargetMessage {
  userName: string;
  userId: number;
  userRole: string;
  userTitle?: string;
  content: string;
  messageId?: number;
  timestamp: number;
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
  ctx: MiokiContext;
  event: any;
  sessionId: string;
  groupId?: number;
  userId: number;
  triggerSkillRole: SkillPermissionRole;
  config: ChatConfig;
  aiService: AIService;
  db: ChatDatabase;
  botRole: "owner" | "admin" | "member";
  /**
   * 当 AI 返回文本内容时立即调用
   * 回调接收文本内容、消息索引、总消息数
   */
  onTextContent?: (
    text: string,
    messageIndex: number,
    totalMessages: number,
  ) => void | Promise<void>;
  /**
   * 已通过 onTextContent 回调发送的消息索引集合
   */
  sentMessageIndices?: Set<number>;
  /**
   * 待附加到下一轮 AI 请求的图片 URL
   */
  pendingImageUrls?: string[];
}

/**
 * 聊天结果
 */
export interface ChatResult {
  messages: string[];
  pendingAt: number[];
  pendingPoke: number[];
  pendingQuote?: number;
  toolCalls: { name: string; args: any; result: any }[];
  emojiPath?: string | null;
  protocolMessages?: ChatCompletionMessageParam[];
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
 * 表达习惯记录
 */
export interface ExpressionRecord {
  id?: number;
  sessionId: string;
  userId: number;
  userName: string;
  situation: string; // 使用场景
  style: string; // 表达风格
  example: string; // 原始示例
  createdAt: number;
}

/**
 * 表情包注册记录
 */
export interface EmojiRecord {
  id?: number;
  fileName: string;
  description: string; // AI 生成的描述
  emotion: string; // 情感标签
  usageCount: number;
  createdAt: number;
}

/**
 * 图片记录
 */
export interface ImageRecord {
  id?: number;
  hash: string; // 图片哈希
  url: string; // 原始 URL
  type: "meme" | "image"; // 图片类型
  description: string; // AI 生成的简要描述
  emotion?: string; // 情感标签（仅表情包）
  character?: string; // 角色名称（仅表情包）
  filePath?: string; // 本地文件路径（仅表情包）
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

/**
 * 动作规划结果
 */
export type PlannerAction = "reply" | "wait" | "complete";

export interface PlannerResult {
  action: PlannerAction;
  reason: string;
  waitMs?: number; // action=wait 时的等待时间
}
