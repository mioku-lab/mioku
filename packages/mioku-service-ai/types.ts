import type {
  AIInstanceInfo,
  AIModelCapability,
  AIModelDescriptor,
  AIModelRole,
  AIProtocol,
  AIProviderConfig,
  AISkill,
  AIThinkingLevel,
  AITool,
  AIUsageContext,
  AIUsageFinalization,
  AIUsageRange,
  AIUsageSummary,
  ChatRuntime,
  ChatRuntimeBaseOptions,
  ChatRuntimeCollectedInfo,
  ChatRuntimeGroupTarget,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimePrivateTarget,
  ChatRuntimePromptInjection,
  ChatRuntimeResult,
  ChatRuntimeSource,
  CompleteOptions as MiokuCompleteOptions,
  CompleteResponse as MiokuCompleteResponse,
  MultimodalContentItem,
  MultimodalMessage,
  SessionToolDefinition,
  TextMessage,
  TOOL_RESULT_FOLLOWUP_KEY,
  ToolCallRecord,
  ToolResultFollowup,
} from "mioku";
import type { AIUsageMeasuredTokens } from "./usage/types";

export type {
  AIInstanceInfo,
  AIModelCapability,
  AIModelDescriptor,
  AIModelRole,
  AIProtocol,
  AIProviderConfig,
  AISkill,
  AIThinkingLevel,
  AITool,
  ChatRuntime,
  ChatRuntimeBaseOptions,
  ChatRuntimeCollectedInfo,
  ChatRuntimeGroupTarget,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimePrivateTarget,
  ChatRuntimePromptInjection,
  ChatRuntimeResult,
  ChatRuntimeSource,
  MultimodalContentItem,
  MultimodalMessage,
  SessionToolDefinition,
  TextMessage,
  TOOL_RESULT_FOLLOWUP_KEY,
  ToolCallRecord,
  ToolResultFollowup,
};

export type UnifiedRole = "system" | "user" | "assistant" | "tool";

export type UnifiedContentPart =
  | { type: "text"; text: string; cacheable?: boolean }
  | {
      type: "image";
      url: string;
      mediaType?: string;
      detail?: "auto" | "low" | "high";
    }
  | {
      type: "video";
      url: string;
      detail?: "auto" | "low" | "high";
    };

export interface UnifiedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UnifiedMessage {
  role: UnifiedRole;
  content: string | UnifiedContentPart[];
  toolCalls?: UnifiedToolCall[];
  responseItems?: any[];
  toolCallId?: string;
  name?: string;
}

export interface UnifiedToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  cacheable?: boolean;
}

export interface ProviderCompleteOptions {
  model: string;
  messages: UnifiedMessage[];
  tools?: UnifiedToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  systemPrompt?: string;
  cachePreference?: "prefer" | "none";
  thinkingLevel?: AIThinkingLevel;
  onTextDelta?: (delta: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export interface ProviderCompleteResponse {
  content: string;
  reasoning: string | null;
  toolCalls: UnifiedToolCall[];
  usage?: AIUsageMeasuredTokens;
  raw?: unknown;
}

export interface ProviderStreamChunk {
  delta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  };
  usage?: AIUsageMeasuredTokens;
  done: boolean;
}

export interface ProviderClient {
  listModels(): Promise<AIModelDescriptor[]>;
  complete(options: ProviderCompleteOptions): Promise<ProviderCompleteResponse>;
}

export interface ProviderFactoryInput {
  provider: AIProviderConfig;
}

export type ProviderFactory = (input: ProviderFactoryInput) => ProviderClient;

export interface CompleteOptions
  extends Omit<MiokuCompleteOptions, "messages" | "tools"> {
  messages: any[];
  tools?: any[];
  cachePreference?: "prefer" | "none";
}

export interface CompleteResponse
  extends Omit<MiokuCompleteResponse, "raw" | "turnMessages"> {
  raw: any;
  turnMessages?: any[];
}

export interface AssistantMessageResult {
  content: string;
  reasoning: string | null;
  toolCalls: UnifiedToolCall[];
  raw: any;
  usage?: AIUsageMeasuredTokens;
  servedBy?: {
    providerId: string;
    modelId: string;
    isFallback: boolean;
  };
}

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
  complete(options: CompleteOptions): Promise<CompleteResponse>;
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

export interface AIService {
  create(options: {
    name: string;
    apiUrl: string;
    apiKey: string;
    modelType: "text" | "multimodal";
    model?: string;
  }): Promise<AIInstance>;
  createInstance(options: {
    name: string;
    providerId: string;
    modelId: string;
    role?: AIModelRole;
  }): Promise<AIInstance>;
  get(name: string): AIInstance | undefined;
  list(): string[];
  listInstances(): AIInstanceInfo[];
  remove(name: string): boolean;
  setDefault(name: string): boolean;
  getDefault(): AIInstance | undefined;
  listProviders(): AIProviderConfig[];
  getProvider(id: string): AIProviderConfig | undefined;
  createProvider(
    input: Omit<AIProviderConfig, "id"> & { id?: string },
  ): Promise<AIProviderConfig>;
  updateProvider(
    id: string,
    input: Partial<AIProviderConfig>,
  ): Promise<AIProviderConfig>;
  removeProvider(id: string): boolean;
  testProvider(
    id: string,
  ): Promise<{ ok: boolean; error?: string; models?: AIModelDescriptor[] }>;
  listModels(providerId?: string): AIModelDescriptor[];
  refreshModels(providerId: string): Promise<AIModelDescriptor[]>;
  registerCustomModel(input: {
    providerId: string;
    modelId: string;
    name?: string;
    capabilities?: AIModelCapability[];
  }): AIModelDescriptor;
  removeCustomModel(modelFullId: string): boolean;
  removeModel(modelFullId: string): boolean;
  setModelThinkingLevel(
    modelFullId: string,
    level: AIThinkingLevel | undefined,
  ): boolean;
  getRoleBindings(): Record<AIModelRole, string | undefined>;
  setRoleBinding(role: AIModelRole, modelFullId: string | undefined): boolean;
  getInstanceByRole(role: AIModelRole): AIInstance | undefined;
  setMainFallbackChain?(modelFullIds: string[]): void;
  getMainFallbackChain?(): string[];
  registerChatRuntime(runtime: ChatRuntime): boolean;
  getChatRuntime(): ChatRuntime | undefined;
  removeChatRuntime(): boolean;
  registerSkill(skill: AISkill): boolean;
  getSkill(skillName: string): AISkill | undefined;
  getAllSkills(): Map<string, AISkill>;
  removeSkill(skillName: string): boolean;
  getTool(toolName: string): AITool | undefined;
  getAllTools(): Map<string, AITool>;
  getUsageSummary(options: {
    range: AIUsageRange;
    botId?: number;
  }): AIUsageSummary;
  cleanupUsageStats(retentionMs?: number): number;
  finalizeUsage(usageId: string, finalization: AIUsageFinalization): boolean;
}

export interface ProvidersFile {
  providers: AIProviderConfig[];
  models: AIModelDescriptor[];
  roles: Partial<Record<AIModelRole, string>>;
  mainFallback?: string[];
  defaultInstance?: string;
}

export function modelFullId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function parseModelFullId(
  fullId: string,
): { providerId: string; modelId: string } | null {
  const idx = fullId.indexOf("/");
  if (idx <= 0 || idx >= fullId.length - 1) return null;
  return {
    providerId: fullId.slice(0, idx),
    modelId: fullId.slice(idx + 1),
  };
}
