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
  content: string | Array<{ type: "text"; text?: string } | { type: "image_url"; image_url?: string }>;
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
  generateNotice?(options: any): Promise<void>;
  requestInformation?(options: any): Promise<any>;
}

export const TOOL_RESULT_FOLLOWUP_KEY = "__miokuFollowup";

// Permission role for skills
export type SkillPermissionRole = "owner" | "admin" | "member";

// Multimodal content item
export interface MultimodalContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: string;
}

// Chat runtime types
export interface ChatRuntimeNoticeOptions {
  sessionId: string;
  groupId?: number;
  userId: number;
  message: string;
  replyContextType: string;
}

export interface ChatRuntimeResult {
  messages: string[];
  pendingAt: number[];
  pendingPoke: number[];
  pendingQuote?: number;
  toolCalls: { name: string; args: any; result: any }[];
  emojiPath?: string | null;
  protocolMessages?: any[];
}

export interface ChatRuntimeInformationRequestOptions {
  sessionId: string;
  groupId?: number;
  userId: number;
  prompt: string;
  injectHistoryCount?: number;
}

// ============ AI Service Interfaces ============

export interface AIInstance {
  generateText(options: { messages: TextMessage[]; model?: string; temperature?: number }): Promise<string>;
  generateMultimodal(options: { messages: MultimodalMessage[]; model?: string; temperature?: number }): Promise<string>;
  complete(options: any): Promise<any>;
  generateWithTools(options: any): Promise<any>;
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
}