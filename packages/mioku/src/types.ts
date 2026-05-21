/**
 * Mioku Service Definition
 */
export interface MiokuService {
  name: string;
  version: string;
  description?: string;

  // 初始化服务
  init(): Promise<void>;

  // 服务提供的 API
  api: Record<string, any>;

  // 清理资源
  dispose?(): Promise<void>;
}

/**
 * AI 相关类型
 */
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

export interface AIInstance {
  generateText(options: any): Promise<string>;
  generateMultimodal(options: any): Promise<string>;
  complete(options: any): Promise<any>;
  generateWithTools(options: any): Promise<any>;
  registerPrompt(name: string, prompt: string): boolean;
  getPrompt(name: string): string | undefined;
  getAllPrompts(): Record<string, string>;
  removePrompt(name: string): boolean;
}

export interface AIService {
  create(options: any): Promise<AIInstance>;
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

export interface ChatRuntime {
  generateNotice(options: any): Promise<void>;
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

export interface SessionToolDefinition {
  name: string;
  tool: AITool;
}

/**
 * 插件元数据
 */
export interface PluginMetadata {
  name: string;
  version: string;
  description?: string;
  // 插件路径
  path: string;
  // 插件 package
  packageJson: any;
  // 插件 Mioku 配置项
  config: PluginPackageConfig;
}

/**
 * 服务元数据
 */
export interface ServiceMetadata {
  name: string;
  version: string;
  description?: string;
  // 服务路径
  path: string;
  // 服务 package
  packageJson: any;
}

/**
 * 插件包配置
 * package.json 中的 mioku 字段
 */
export interface PluginPackageConfig {
  // 依赖的服务
  services?: string[];
  // 帮助信息
  help?: PluginHelp;
}

/**
 * 插件帮助信息
 */
export interface PluginHelp {
  // 插件名称
  title: string;
  // 描述
  description: string;
  commands: Array<{
    // 命令
    cmd: string;
    // 命令描述
    desc: string;
    // 使用示例
    usage?: string;
    // 使用权限
    role?: CommandRole;
  }>;
}

/**
 * 指令权限级别
 * 主人 管理员 群主 群成员
 */
export type CommandRole = "master" | "admin" | "owner" | "member";