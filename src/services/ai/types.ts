import type { AISkill, AITool } from "../../core/types";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AIUsageContext,
  AIUsageFinalization,
  AIUsageRange,
  AIUsageSummary,
} from "./usage/types";

/**
 * 文本消息
 */
export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 多模态消息内容项
 */
export interface MultimodalContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/**
 * 多模态消息
 */
export interface MultimodalMessage {
  role: "system" | "user" | "assistant";
  content: string | MultimodalContentItem[];
}

export const TOOL_RESULT_FOLLOWUP_KEY = "__miokuFollowup";

export interface ToolResultFollowup {
  text: string;
  images: Array<{
    url: string;
    detail?: "auto" | "low" | "high";
  }>;
}

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  name: string;
  // 参数
  arguments: any;
  // 调用结果
  result: any;
}

/**
 * 原始补全请求参数
 */
export interface CompleteOptions {
  model?: string;
  // 补全消息参数
  messages: ChatCompletionMessageParam[];
  // 补全工具参数
  tools?: ChatCompletionTool[];
  // 静态工具列表
  executableTools?: SessionToolDefinition[];
  // 获取动态工具列表函数
  executableToolsProvider?: () => SessionToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  // 最大迭代次数
  maxIterations?: number;
  // 流式输出
  stream?: boolean;
  // 流式文本回调函数
  onTextDelta?: (delta: string) => void | Promise<void>;
  // 使用统计上下文
  usageContext?: AIUsageContext;
  // 使用统计中从系统消息扣出、计入上下文的 token 数
  usageContextTokens?: number;
  usageBreakdown?: AIUsageFinalization["breakdown"];
}

/**
 * 原始补全响应
 */
export interface CompleteResponse {
  // 文本响应内容
  content: string | null;
  // 推理内容
  reasoning: string | null;
  toolCalls: {
    id: string;
    name: string;
    // 工具调用参数
    arguments: string;
  }[];
  //原始响应消息
  raw: ChatCompletionMessageParam;
  // 迭代次数
  iterations?: number;
  // 所有工具调用的完整记录
  allToolCalls?: ToolCallRecord[];
  // 本轮交互的全部消息
  turnMessages?: ChatCompletionMessageParam[];
}

export interface SessionToolDefinition {
  name: string;
  // 工具定义
  tool: AITool;
}

export interface ChatRuntimePromptInjection {
  // 注入内容
  content: string;
  // 可选标题
  title?: string;
}

export interface ChatRuntimeGroupTarget {
  selfId: number;
  groupId: number;
}

export interface ChatRuntimePrivateTarget {
  selfId: number;
  userId: number;
}

export type ChatRuntimeSource =
  | { event: any }
  | ChatRuntimeGroupTarget
  | ChatRuntimePrivateTarget;

export type ChatRuntimeBaseOptions = ChatRuntimeSource & {
  targetMessage?: string;
  promptInjections?: ChatRuntimePromptInjection[];
  send?: boolean;
};

export type ChatRuntimeInformationRequestOptions = ChatRuntimeBaseOptions & {
  task: string;
  schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  toolName?: string;
  toolDescription?: string;
};

export type ChatRuntimeNoticeOptions = ChatRuntimeBaseOptions & {
  instruction: string;
};

export interface ChatRuntimeCollectedInfo {
  // 内容
  data: any;
  // 询问信息是否完成
  isComplete?: boolean;
  // 对信息的把握程度
  confidence?: number;
  // 备注
  notes?: string;
}

export interface ChatRuntimeResult {
  // 发送的消息内容
  messages: string[];
  //工具调用历史
  toolCalls: ToolCallRecord[];
  // 结果
  collectedInfo: ChatRuntimeCollectedInfo | null;
}

export interface ChatRuntime {
  // 向用户查询内容
  requestInformation(
    options: ChatRuntimeInformationRequestOptions,
  ): Promise<ChatRuntimeResult>;
  // 通知信息
  generateNotice(options: ChatRuntimeNoticeOptions): Promise<ChatRuntimeResult>;
}

/**
 * AI 实例接口
 */
export interface AIInstance {
  // 文本模型生成
  generateText(options: {
    prompt?: string;
    messages: TextMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string>;

  // 多模态模型生成
  generateMultimodal(options: {
    prompt?: string;
    messages: MultimodalMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string>;

  // 代工具调用的生成
  generateWithTools(options: {
    prompt?: string;
    messages: TextMessage[] | MultimodalMessage[];
    model?: string;
    temperature?: number;
    maxIterations?: number;
  }): Promise<{
    content: string;
    iterations: number;
    allToolCalls: ToolCallRecord[];
  }>;

  /**
   * 原始补全调用，提供对 OpenAI API 的直接访问。
   * 当传入 executableTools 时，会在当前请求内执行标准 tool loop
   */
  complete(options: CompleteOptions): Promise<CompleteResponse>;
  setUsageContext?(context: AIUsageContext | undefined): void;
  withUsageContext?<T>(
    context: AIUsageContext | undefined,
    fn: () => Promise<T>,
  ): Promise<T>;

  // 注册提示词
  registerPrompt(name: string, prompt: string): boolean;
  // 获取提示词
  getPrompt(name: string): string | undefined;
  // 获取全部提示词
  getAllPrompts(): Record<string, string>;
  // 移除提示词
  removePrompt(name: string): boolean;
}

/**
 * AI 服务接口
 */
export interface AIService {
  // 实例管理
  create(options: {
    name: string;
    apiUrl: string;
    apiKey: string;
    modelType: "text" | "multimodal";
    model?: string;
  }): Promise<AIInstance>;
  get(name: string): AIInstance | undefined;
  list(): string[];
  remove(name: string): boolean;

  // 默认实例
  setDefault(name: string): boolean;
  getDefault(): AIInstance | undefined;

  // Chat Runtime
  registerChatRuntime(runtime: ChatRuntime): boolean;
  getChatRuntime(): ChatRuntime | undefined;
  removeChatRuntime(): boolean;

  // Skill 管理
  registerSkill(skill: AISkill): boolean;
  getSkill(skillName: string): AISkill | undefined;
  getAllSkills(): Map<string, AISkill>;
  removeSkill(skillName: string): boolean;

  // 工具查询
  getTool(toolName: string): AITool | undefined;
  getAllTools(): Map<string, AITool>;

  // 使用统计
  getUsageSummary(options: {
    range: AIUsageRange;
    botId?: number;
  }): AIUsageSummary;
  cleanupUsageStats(retentionMs?: number): number;
  finalizeUsage(usageId: string, finalization: AIUsageFinalization): boolean;
}

// 单次请求的原始响应
export interface AssistantMessageResult {
  content: string;
  reasoning: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  raw: ChatCompletionMessageParam;
  usage?: import("./usage/types").AIUsageMeasuredTokens;
}
