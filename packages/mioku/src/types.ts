// Mioku framework types — single source of truth for the public API surface.

// ---------- framework ----------

/** 框架服务的最小形态：init 负责初始化，api 是对外暴露的接口对象 */
export interface MiokuService {
  name: string;
  version: string;
  description?: string;
  init(): Promise<void>;
  api: Record<string, any>;
  dispose?(): Promise<void>;
}

/** package.json 的 `mioku` 字段中控制框架行为的运行时配置 */
export interface MiokuRuntimeConfig {
  plugins?: string[];
  plugins_dir?: string;
  services_dir?: string;
  [key: string]: unknown;
}

/** 宽松的 package.json 结构，用于读取插件的元信息 */
export interface PackageJsonLike {
  name?: string;
  version?: string;
  description?: string;
  keywords?: readonly string[];
  mioku?: unknown;
  dependencies?: Record<string, string>;
}

/** 已加载插件的元信息，供内置 core 插件与帮助系统使用 */
export interface PluginMetadata {
  name: string;
  version: string;
  description?: string;
  path: string;
  packageJson: PackageJsonLike;
  config: PluginPackageConfig;
}

/** 已发现服务的元信息 */
export interface ServiceMetadata {
  name: string;
  version: string;
  description?: string;
  path: string;
  packageJson: PackageJsonLike;
}

// ---------- plugin package config ----------

/** 插件 package.json 中 `mioku` 字段的解析结果 */
export interface PluginPackageConfig {
  /** 插件依赖的服务名，如 `ai`、`config` */
  services?: string[];
  help?: PluginHelp;
  accessHooks?: AccessHook[];
}

/** 插件的帮助信息，框架会自动收集并注册到帮助服务 */
export interface PluginHelp {
  title: string;
  description: string;
  commands: Array<{
    cmd: string;
    desc: string;
    usage?: string;
    role?: CommandRole;
  }>;
}

export type CommandRole = "master" | "admin" | "owner" | "member";

/**
 * - `"master"`：仅 bot 主人可触发
 * - `"owner"`：bot 主人或当前群群主
 * - `"admin"`：bot 主人、配置管理员、当前群群主或群管理员
 * - `"member"`：所有人
 *
 */
export type SkillPermissionRole = "master" | "owner" | "admin" | "member";

export function normalizeSkillPermissionRole(
  role: unknown,
): SkillPermissionRole {
  const normalized = String(role ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "master" ||
    normalized === "owner" ||
    normalized === "admin" ||
    normalized === "member"
  ) {
    return normalized as SkillPermissionRole;
  }
  return "member";
}

export interface AccessHook {
  id: string;
  /** 匹配文本的正则（字符串形式，如 `/^\.help$/`），用于在事件层面拦截/放行 */
  match?: string;
  /** 命中的事件路由，如 `notice.group.poke` */
  event?: string;
  description?: string;
}

export type AccessAction = "allow" | "block";

export interface AccessRuleEntry {
  action: AccessAction;
}

export interface AccessScopeConfig {
  plugins?: Record<string, AccessRuleEntry>;
  commands?: Record<string, Record<string, AccessRuleEntry>>;
}

/** 访问控制配置：按全局 / 群 / 用户三级对插件与指令放行或拦截 */
export interface AccessControlConfig {
  version: 1;
  global: AccessScopeConfig;
  groups: Record<string, AccessScopeConfig>;
  users: Record<string, AccessScopeConfig>;
}

// ---------- built-in service contracts ----------

/** 配置服务：插件的配置文件统一注册、读取与热更新 */
export interface ConfigService {
  registerConfig(
    pluginName: string,
    configName: string,
    initialConfig: any,
  ): Promise<boolean>;
  updateConfig(
    pluginName: string,
    configName: string,
    updates: any,
  ): Promise<boolean>;
  getConfig(pluginName: string, configName: string): Promise<any>;
  getPluginConfigs(pluginName: string): Promise<Record<string, any>>;
  /** 订阅配置变化，返回取消订阅函数 */
  onConfigChange(
    pluginName: string,
    configName: string,
    callback: (newConfig: any) => void,
  ): () => void;
}

/** 截图服务：把 HTML / Markdown / URL 渲染成图片 */
export interface ScreenshotService {
  screenshot(html: string, options?: any): Promise<string>;
  screenshotMarkdown(markdownContent: string, options?: any): Promise<string>;
  screenshotFromUrl(url: string, options?: any): Promise<string>;
  cleanupTemp(olderThanMs?: number): Promise<number>;
}

/** 帮助服务：插件的帮助信息注册与查询 */
export interface HelpService {
  registerHelp(pluginName: string, help: PluginHelp): void;
  getHelp(pluginName: string): PluginHelp | undefined;
  getAllHelp(): Map<string, PluginHelp>;
  unregisterHelp(pluginName: string): boolean;
}

export interface WebUIService {
  getSettings(): { port: number; host: string; packageManager: string };
}

// ---------- AI service ----------

/** AI 工具：暴露给模型的函数，供模型在对话中调用 */
export interface AITool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any, event?: any) => Promise<any> | any;
}

/** AI 技能：一组工具的组合，可按权限开放给不同角色的用户 */
export interface AISkill {
  name: string;
  description: string;
  permission?: SkillPermissionRole;
  tools: AITool[];
}

export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 多模态消息内容：文本或图片 URL */
export interface MultimodalContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface MultimodalMessage {
  role: "system" | "user" | "assistant";
  content: string | MultimodalContentItem[];
}

/** 一次工具调用的记录（名称、参数与结果） */
export interface ToolCallRecord {
  name: string;
  arguments: any;
  result: any;
}

export interface SessionToolDefinition {
  name: string;
  tool: AITool;
}

/** 模型补全请求的完整选项 */
export interface CompleteOptions {
  model?: string;
  messages: any[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: any[];
  /** 会话内可执行的工具（自动进入工具循环） */
  executableTools?: SessionToolDefinition[];
  executableToolsProvider?: () => SessionToolDefinition[];
  maxIterations?: number;
  onTextDelta?: (delta: string) => void | Promise<void>;
  usageContext?: AIUsageContext;
  usageContextTokens?: number;
  usageBreakdown?: AIUsageFinalization["breakdown"];
}

export interface CompleteResponse {
  content: string | null;
  reasoning: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  raw: any;
  turnMessages: any[];
  iterations?: number;
  allToolCalls?: ToolCallRecord[];
}

export type AIProtocol =
  | "openai-chat"
  | "openai-response"
  | "anthropic"
  | "gemini";

/** 模型能力标记：文本 / 视觉 / 工具调用 / 推理 */
export type AIModelCapability = "text" | "vision" | "tool-use" | "reasoning";

/** 思考等级，部分推理模型支持从 off 到 max 逐级调节 */
export type AIThinkingLevel =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const AI_THINKING_LEVELS: AIThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const AI_GEMINI_THINKING_LEVELS: AIThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
];

export function normalizeAIThinkingLevel(
  value: unknown,
  protocol?: AIProtocol,
): AIThinkingLevel | undefined {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase() as AIThinkingLevel;
  if (!raw) return undefined;
  if (protocol === "gemini") {
    return AI_GEMINI_THINKING_LEVELS.includes(raw) ? raw : undefined;
  }
  return AI_THINKING_LEVELS.includes(raw) ? raw : undefined;
}

/** 模型角色：主对话 / 干活 / 看图 */
export type AIModelRole = "main" | "working" | "vision";

/** 一个模型提供商的连接配置 */
export interface AIProviderConfig {
  id: string;
  name: string;
  protocol: AIProtocol;
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
  headers?: Record<string, string>;
}

/** 模型描述：归属于某个提供商，带能力与上下文窗口信息 */
export interface AIModelDescriptor {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  capabilities: AIModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  isCustom?: boolean;
  thinkingLevel?: AIThinkingLevel;
}

export interface AIInstanceInfo {
  name: string;
  providerId: string;
  modelId: string;
  role?: AIModelRole;
}

/** AI 实例：一个绑定到具体提供商与模型的调用句柄 */
export interface AIInstance {
  generateText(options: {
    prompt?: string;
    messages: TextMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string>;
  generateMultimodal(options: {
    prompt?: string;
    messages: MultimodalMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string>;
  complete(options: CompleteOptions): Promise<CompleteResponse>;
  generateWithTools(options: {
    prompt?: string;
    messages: TextMessage[] | MultimodalMessage[];
    model?: string;
    temperature?: number;
    maxIterations?: number;
  }): Promise<any>;
  setUsageContext?(context: AIUsageContext | undefined): void;
  withUsageContext?<T>(
    context: AIUsageContext | undefined,
    fn: () => Promise<T>,
  ): Promise<T>;
  registerPrompt(name: string, prompt: string): boolean;
  getPrompt(name: string): string | undefined;
  getAllPrompts(): Record<string, string>;
  removePrompt(name: string): boolean;
}

/** AI 服务：实例 / 提供商 / 模型 / 技能的统一管理入口 */
export interface AIService {
  create(options: {
    name: string;
    apiUrl: string;
    apiKey: string;
    modelType: "text" | "multimodal";
    model?: string;
  }): Promise<AIInstance>;
  createInstance?(options: {
    name: string;
    providerId: string;
    modelId: string;
    role?: AIModelRole;
  }): Promise<AIInstance>;
  get(name: string): AIInstance | undefined;
  list(): string[];
  listInstances?(): AIInstanceInfo[];
  remove(name: string): boolean;
  setDefault(name: string): boolean;
  getDefault(): AIInstance | undefined;
  listProviders?(): AIProviderConfig[];
  getProvider?(id: string): AIProviderConfig | undefined;
  createProvider?(
    input: Omit<AIProviderConfig, "id"> & { id?: string },
  ): Promise<AIProviderConfig>;
  updateProvider?(
    id: string,
    input: Partial<AIProviderConfig>,
  ): Promise<AIProviderConfig>;
  removeProvider?(id: string): boolean;
  testProvider?(
    id: string,
  ): Promise<{ ok: boolean; error?: string; models?: AIModelDescriptor[] }>;
  listModels?(providerId?: string): AIModelDescriptor[];
  refreshModels?(providerId: string): Promise<AIModelDescriptor[]>;
  registerCustomModel?(input: {
    providerId: string;
    modelId: string;
    name?: string;
    capabilities?: AIModelCapability[];
  }): AIModelDescriptor;
  removeCustomModel?(modelFullId: string): boolean;
  removeModel?(modelFullId: string): boolean;
  setModelThinkingLevel?(
    modelFullId: string,
    level: AIThinkingLevel | undefined,
  ): boolean;
  getRoleBindings?(): Record<AIModelRole, string | undefined>;
  setRoleBinding?(role: AIModelRole, modelFullId: string | undefined): boolean;
  getInstanceByRole?(role: AIModelRole): AIInstance | undefined;
  setMainFallbackChain?(modelFullIds: string[]): void;
  getMainFallbackChain?(): string[];
  registerChatRuntime(runtime: any): boolean;
  getChatRuntime(): any;
  removeChatRuntime(): boolean;
  registerSkill(skill: AISkill): boolean;
  getSkill(skillName: string): AISkill | undefined;
  getAllSkills(): Map<string, AISkill>;
  removeSkill(skillName: string): boolean;
  getTool(toolName: string): AITool | undefined;
  getAllTools(): Map<string, AITool>;
  getUsageSummary?(options: {
    range: AIUsageRange;
    botId?: number;
  }): AIUsageSummary;
  cleanupUsageStats?(retentionMs?: number): number;
  finalizeUsage?(usageId: string, finalization: AIUsageFinalization): boolean;
}

// ---------- chat runtime ----------

/** 聊天运行时：让插件复用 chat 插件的"发通知 / 收集信息"能力 */
export interface ChatRuntime {
  generateNotice(options: ChatRuntimeNoticeOptions): Promise<ChatRuntimeResult>;
  requestInformation(
    options: ChatRuntimeInformationRequestOptions,
  ): Promise<ChatRuntimeResult>;
}

export const TOOL_RESULT_FOLLOWUP_KEY = "__miokuFollowup";

/** 工具结果附带的内容：文本与图片/视频引用 */
export interface ToolResultFollowup {
  text: string;
  images?: Array<{ url: string; detail?: "auto" | "low" | "high" }>;
  videos?: Array<{ url: string; detail?: "auto" | "low" | "high" }>;
}

export interface ChatRuntimePromptInjection {
  content: string;
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

export type ChatRuntimeNoticeOptions = ChatRuntimeBaseOptions & {
  instruction: string;
};

/** 让 AI 按给定 JSON Schema 收集并返回结构化信息 */
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

export interface ChatRuntimeCollectedInfo {
  data: any;
  isComplete?: boolean;
  confidence?: number;
  notes?: string;
}

export interface ChatRuntimeResult {
  messages: string[];
  toolCalls: ToolCallRecord[];
  collectedInfo: ChatRuntimeCollectedInfo | null;
  pendingAt?: number[];
  pendingPoke?: number[];
  pendingQuote?: number;
  emojiPath?: string | null;
  protocolMessages?: any[];
}

// ---------- usage tracking ----------

export type AIUsageRange = "today" | "7d" | "30d";

export type AIUsageScope = "all" | "bot";

export interface AIUsageContext {
  usageId?: string;
  source?: string;
  botId?: number;
  groupId?: number;
  groupName?: string;
  userId?: number;
  userName?: string;
  sessionId?: string;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
}

export interface AIUsageBreakdown {
  systemPromptTokens?: number;
  chatHistoryTokens?: number;
  toolDefinitionTokens?: number;
  toolUseTokens?: number;
  otherContextTokens?: number;
}

export interface AIUsageFinalization {
  sentUserMessages?: number;
  sentAssistantMessages?: number;
  breakdown?: AIUsageBreakdown;
}

export interface AIUsageBotOption {
  botId: number;
  label: string;
}

export interface AIUsageSummary {
  generatedAt: number;
  range: AIUsageRange;
  scope: AIUsageScope;
  botId?: number;
  bots: AIUsageBotOption[];
  totals: {
    requests: number;
    successfulRequests: number;
    failedRequests: number;
    userMessages: number;
    assistantMessages: number;
    systemMessages: number;
    toolMessages: number;
    sentUserMessages: number;
    sentAssistantMessages: number;
    inputTokens: number;
    outputTokens: number;
    systemPromptTokens: number;
    totalTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    toolDefinitionTokens: number;
    toolUseTokens: number;
    chatHistoryTokens: number;
    otherContextTokens: number;
    durationMs: number;
    toolCalls: number;
  };
  rates: {
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  };
  toolRanking: Array<{ name: string; count: number }>;
  groupRanking: Array<{
    groupId: number;
    groupName: string;
    requests: number;
    totalTokens: number;
    userMessages: number;
    assistantMessages: number;
    errorRate: number;
  }>;
  tokenFlow: Array<{
    name: "输入" | "输出" | "缓存写入" | "缓存读取";
    value: number;
  }>;
  tokenCategories: Array<{
    name: "系统提示词" | "工具定义" | "工具使用" | "聊天上下文" | "其他上下文";
    value: number;
  }>;
  dailyActivity: Array<{
    day: string;
    requests: number;
    userMessages: number;
    assistantMessages: number;
    totalTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  }>;
  hourlyActivity: Array<{
    hour: string;
    requests: number;
    userMessages: number;
    assistantMessages: number;
    totalTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    throughputTokPerMin: number;
    averageTokensPerUserMessage: number;
    averageTokensPerSentMessage: number;
    errorRate: number;
    cacheHitRate: number;
  }>;
}
