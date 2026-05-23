/**
 * Service interface definitions for built-in services
 * These are used for type annotations in plugins
 */

// ============ Core Service Interfaces ============

// Config Service
export interface ConfigService {
  registerConfig(pluginName: string, configName: string, initialConfig: any): Promise<boolean>;
  updateConfig(pluginName: string, configName: string, updates: any): Promise<boolean>;
  getConfig(pluginName: string, configName: string): Promise<any>;
  getPluginConfigs(pluginName: string): Promise<Record<string, any>>;
  onConfigChange(pluginName: string, configName: string, callback: (newConfig: any) => void): () => void;
}

// Screenshot Service
export interface ScreenshotService {
  screenshot(html: string, options?: any): Promise<string>;
  screenshotMarkdown(markdownContent: string, options?: any): Promise<string>;
  screenshotFromUrl(url: string, options?: any): Promise<string>;
  cleanupTemp(olderThanMs?: number): Promise<number>;
}

// Help Service
export interface HelpService {
  registerHelp(pluginName: string, help: any): void;
  getHelp(pluginName: string): any;
  getAllHelp(): Map<string, any>;
  unregisterHelp(pluginName: string): void;
}

// WebUI Service
export interface WebUIService {
  getSettings(): { port: number; host: string; packageManager: string };
}

// ============ AI Service Types ============

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

export interface AISkill {
  name: string;
  description: string;
  permission?: "owner" | "admin" | "member";
  tools: AITool[];
}

export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MultimodalMessage {
  role: "system" | "user" | "assistant";
  content: string | MultimodalContentItem[];
}

export interface ToolCallRecord {
  name: string;
  arguments: any;
  result: any;
}

export interface SessionToolDefinition {
  name: string;
  tool: AITool;
}

export interface CompleteOptions {
  model?: string;
  messages: any[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: any[];
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

export interface ChatRuntime {
  generateNotice(options: ChatRuntimeNoticeOptions): Promise<ChatRuntimeResult>;
  requestInformation(options: ChatRuntimeInformationRequestOptions): Promise<ChatRuntimeResult>;
}

export const TOOL_RESULT_FOLLOWUP_KEY = "__miokuFollowup";

export interface ToolResultFollowup {
  text: string;
  images: Array<{
    url: string;
    detail?: "auto" | "low" | "high";
  }>;
}

// Permission role for skills
export type SkillPermissionRole = "owner" | "admin" | "member";

// Multimodal content item
export interface MultimodalContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

// Chat runtime types
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

export type AIUsageRange = "today" | "7d" | "30d";

export interface AIUsageContext {
  usageId?: string;
  source?: string;
  botId?: number;
  groupId?: number;
  groupName?: string;
  userId?: number;
  userName?: string;
  sessionId?: string;
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

export interface AIUsageSummary {
  range: AIUsageRange;
  total: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  };
  byBot: Array<{
    botId: number | null;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  }>;
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

export interface LegacyChatRuntimeNoticeOptions {
  sessionId: string;
  groupId?: number;
  userId: number;
  message: string;
  replyContextType: string;
}

export interface LegacyChatRuntimeInformationRequestOptions {
  sessionId: string;
  groupId?: number;
  userId: number;
  prompt: string;
  injectHistoryCount?: number;
}

// ============ AI Service Interfaces ============

export interface AIInstance {
  generateText(options: { prompt?: string; messages: TextMessage[]; model?: string; temperature?: number; max_tokens?: number }): Promise<string>;
  generateMultimodal(options: { prompt?: string; messages: MultimodalMessage[]; model?: string; temperature?: number; max_tokens?: number }): Promise<string>;
  complete(options: CompleteOptions): Promise<CompleteResponse>;
  generateWithTools(options: { prompt?: string; messages: TextMessage[] | MultimodalMessage[]; model?: string; temperature?: number; maxIterations?: number }): Promise<any>;
  setUsageContext?(context: AIUsageContext | undefined): void;
  withUsageContext?<T>(context: AIUsageContext | undefined, fn: () => Promise<T>): Promise<T>;
  registerPrompt(name: string, prompt: string): boolean;
  getPrompt(name: string): string | undefined;
  getAllPrompts(): Record<string, string>;
  removePrompt(name: string): boolean;
}

export interface AIService {
  create(options: { name: string; apiUrl: string; apiKey: string; modelType: "text" | "multimodal"; model?: string }): Promise<AIInstance>;
  get(name: string): AIInstance | undefined;
  list(): string[];
  remove(name: string): boolean;
  setDefault(name: string): boolean;
  getDefault(): AIInstance | undefined;
  registerChatRuntime(runtime: any): boolean;
  getChatRuntime(): any;
  removeChatRuntime(): boolean;
  registerSkill(skill: AISkill): boolean;
  getSkill(skillName: string): AISkill | undefined;
  getAllSkills(): Map<string, AISkill>;
  removeSkill(skillName: string): boolean;
  getTool(toolName: string): AITool | undefined;
  getAllTools(): Map<string, AITool>;
  getUsageSummary?(options: { range: AIUsageRange; botId?: number }): AIUsageSummary;
  cleanupUsageStats?(retentionMs?: number): number;
  finalizeUsage?(usageId: string, finalization: AIUsageFinalization): boolean;
}
