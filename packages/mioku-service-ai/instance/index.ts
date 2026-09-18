import { logger as miokiLogger } from "mioku";
import type {
  AIInstance,
  AIModelRole,
  AISkill,
  AIThinkingLevel,
  MultimodalMessage,
  TextMessage,
  ToolCallRecord,
} from "mioku";
import type { AIUsageContext, AIUsageStore } from "../usage/types";
import { UsageTracker } from "../usage/tracker";
import { runToolLoop } from "../core/tool-loop";
import type {
  AIInstance as LocalAIInstance,
  AssistantMessageResult,
  CompleteOptions,
  CompleteResponse,
  ProviderClient,
  UnifiedMessage,
  UnifiedToolDefinition,
} from "../types";
import { contentToText } from "../providers/base";

const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

function isRateLimitError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const s = String(err).toLowerCase();
  return (
    s.includes("429") || s.includes("rate limit") || s.includes("rate_limit")
  );
}

async function retryOn429<T>(
  fn: () => Promise<T>,
  log: { warn: (...args: unknown[]) => void },
  label?: string,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      if (attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw err;
      const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      const attemptLabel = `${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length}`;
      log.warn(
        `[ai]${label ? ` ${label}` : ""} 命中 429，等待 ${delay / 1000}s 后第 ${attemptLabel} 次重试: ${err}`,
      );
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export interface AIInstanceOptions {
  name: string;
  providerId: string;
  modelId: string;
  client: ProviderClient;
  globalSkills: Map<string, AISkill>;
  usageStore: AIUsageStore;
  role?: AIModelRole;
  fallbackChain?: AIInstanceImpl[];
  thinkingLevelProvider?: () => AIThinkingLevel | undefined;
}

export class AIInstanceImpl implements LocalAIInstance {
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly role?: AIModelRole;
  private readonly client: ProviderClient;
  private readonly globalSkills: Map<string, AISkill>;
  private readonly usageStore: AIUsageStore;
  private readonly prompts = new Map<string, string>();
  private usageContext: AIUsageContext | undefined;
  private fallbackChain: AIInstanceImpl[];
  private readonly thinkingLevelProvider?: () => AIThinkingLevel | undefined;

  constructor(options: AIInstanceOptions) {
    this.name = options.name;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.role = options.role;
    this.client = options.client;
    this.globalSkills = options.globalSkills;
    this.usageStore = options.usageStore;
    this.fallbackChain = options.fallbackChain ?? [];
    this.thinkingLevelProvider = options.thinkingLevelProvider;
  }

  setFallbackChain(chain: AIInstanceImpl[]): void {
    this.fallbackChain = chain;
  }

  getFallbackChain(): AIInstanceImpl[] {
    return this.fallbackChain;
  }

  async generateText(options: {
    prompt?: string;
    messages: TextMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string> {
    const model = this.resolveModel(options.model);
    const messages = ensureUserTurn(
      options.prompt
        ? [
            { role: "system" as const, content: options.prompt },
            ...options.messages,
          ]
        : [...options.messages],
    );
    const response = await this.complete({
      model,
      messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      cachePreference: "prefer",
    });
    return response.content || "";
  }

  async generateMultimodal(options: {
    prompt?: string;
    messages: MultimodalMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string> {
    const model = this.resolveModel(options.model);
    const converted = convertMessages(options.messages);
    const messages = ensureUserTurn(
      options.prompt
        ? [{ role: "system" as const, content: options.prompt }, ...converted]
        : converted,
    );
    const response = await this.complete({
      model,
      messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      cachePreference: "prefer",
    });
    return response.content || "";
  }

  async complete(options: CompleteOptions): Promise<CompleteResponse> {
    const model = this.resolveModel(options.model);
    const tracker = new UsageTracker({
      model,
      stream: Boolean(options.stream),
      context: options.usageContext ?? this.usageContext,
      startedAt: Date.now(),
      initialMessages: options.messages as any,
      initialTools: options.tools as any,
      explicitContextTokens: options.usageContextTokens,
      explicitBreakdown: options.usageBreakdown,
      usageStore: this.usageStore,
    });

    try {
      const hasExecutableTools =
        (options.executableTools && options.executableTools.length > 0) ||
        !!options.executableToolsProvider;
      const response = hasExecutableTools
        ? await this.completeWithExecutableTools(options, model, tracker)
        : await this.completeOnce(options, model, tracker);
      tracker.finish(true);
      return response;
    } catch (error) {
      tracker.finish(false, String(error));
      throw error;
    }
  }

  setUsageContext(context: AIUsageContext | undefined): void {
    this.usageContext = context;
  }

  async withUsageContext<T>(
    context: AIUsageContext | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.usageContext;
    this.usageContext = context;
    try {
      return await fn();
    } finally {
      this.usageContext = previous;
    }
  }

  private async completeOnce(
    options: CompleteOptions,
    model: string,
    tracker: UsageTracker,
  ): Promise<CompleteResponse> {
    const assistant = await this.requestAssistantMessage({
      model,
      messages: toUnifiedMessages(options.messages),
      tools: toUnifiedTools(options.tools),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens,
      stream: options.stream,
      onTextDelta: options.onTextDelta,
      cachePreference: options.cachePreference ?? "prefer",
    });
    tracker.recordAssistant(assistant);
    if (assistant.usage) tracker.recordMeasuredTokens(assistant.usage);
    return {
      content: assistant.content || null,
      reasoning: assistant.reasoning,
      toolCalls: assistant.toolCalls,
      raw: assistant.raw,
      turnMessages: [assistant.raw],
    };
  }

  private async completeWithExecutableTools(
    options: CompleteOptions,
    model: string,
    tracker: UsageTracker,
  ): Promise<CompleteResponse> {
    return runToolLoop(
      {
        requestAssistantMessage: (args) => this.requestAssistantMessage(args),
        globalSkillNames: [...this.globalSkills.keys()],
      },
      options,
      model,
      tracker,
    );
  }

  private async requestAssistantMessage(args: {
    model: string;
    messages: UnifiedMessage[] | any[];
    tools?: UnifiedToolDefinition[] | any[];
    temperature: number;
    max_tokens?: number;
    stream?: boolean;
    onTextDelta?: (delta: string) => void | Promise<void>;
    cachePreference?: "prefer" | "none";
  }): Promise<AssistantMessageResult> {
    const mainCall = () => this.callOwnClient(args);
    try {
      const result = await mainCall();
      return {
        ...result,
        servedBy: {
          providerId: this.providerId,
          modelId: this.modelId,
          isFallback: false,
        },
      };
    } catch (mainErr) {
      if (this.role === "main" && this.fallbackChain.length > 0) {
        miokiLogger.warn(
          `[ai] 主模型 (${this.providerId}/${this.modelId}) 调用失败: ${mainErr}`,
        );
        let lastErr: unknown = mainErr;
        for (let i = 0; i < this.fallbackChain.length; i++) {
          const fb = this.fallbackChain[i];
          const fbArgs = { ...args, model: fb.modelId };
          try {
            const result = await retryOn429(
              () => fb.callOwnClient(fbArgs),
              miokiLogger,
              `错误转移 ${i + 1} (${fb.providerId}/${fb.modelId})`,
            );
            return {
              ...result,
              servedBy: {
                providerId: fb.providerId,
                modelId: fb.modelId,
                isFallback: true,
              },
            };
          } catch (fbErr) {
            miokiLogger.warn(
              `[ai] 错误转移 ${i + 1}/${this.fallbackChain.length} (${fb.providerId}/${fb.modelId}) 失败: ${fbErr}`,
            );
            lastErr = fbErr;
          }
        }
        throw lastErr;
      }

      const result = await retryOn429(
        mainCall,
        miokiLogger,
        `${this.providerId}/${this.modelId}`,
      );
      return {
        ...result,
        servedBy: {
          providerId: this.providerId,
          modelId: this.modelId,
          isFallback: false,
        },
      };
    }
  }

  private async callOwnClient(args: {
    model: string;
    messages: UnifiedMessage[] | any[];
    tools?: UnifiedToolDefinition[] | any[];
    temperature: number;
    max_tokens?: number;
    stream?: boolean;
    onTextDelta?: (delta: string) => void | Promise<void>;
    cachePreference?: "prefer" | "none";
  }): Promise<AssistantMessageResult> {
    const messages = toUnifiedMessages(args.messages);
    const tools = toUnifiedTools(args.tools);
    const result = await this.client.complete({
      model: args.model,
      messages,
      tools,
      temperature: args.temperature,
      maxTokens: args.max_tokens,
      stream: args.stream,
      onTextDelta: args.onTextDelta,
      cachePreference: args.cachePreference ?? "prefer",
      thinkingLevel: this.thinkingLevelProvider?.(),
    });

    return {
      content: result.content || "",
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      raw: result.raw ?? buildAssistantRaw(result.content, result.toolCalls),
      usage: result.usage,
    };
  }

  async generateWithTools(options: {
    prompt?: string;
    messages: TextMessage[] | MultimodalMessage[];
    model?: string;
    temperature?: number;
    maxIterations?: number;
  }): Promise<{
    content: string;
    iterations: number;
    allToolCalls: ToolCallRecord[];
  }> {
    const executableTools = [];
    for (const [skillName, skill] of this.globalSkills) {
      for (const tool of skill.tools) {
        executableTools.push({
          name: `${skillName}-${tool.name}`,
          tool: {
            ...tool,
            description: `[${skillName}] ${tool.description}`,
          },
        });
      }
    }

    let messages = convertMessages(options.messages);
    if (options.prompt) {
      messages = [{ role: "system", content: options.prompt }, ...messages];
    }

    const response = await this.complete({
      model: options.model,
      messages,
      executableTools,
      temperature: options.temperature,
      maxIterations: options.maxIterations,
      cachePreference: "prefer",
    });

    return {
      content: response.content || "",
      iterations: response.iterations ?? 1,
      allToolCalls: response.allToolCalls || [],
    };
  }

  registerPrompt(name: string, prompt: string): boolean {
    this.prompts.set(name, prompt);
    return true;
  }

  getPrompt(name: string): string | undefined {
    return this.prompts.get(name);
  }

  getAllPrompts(): Record<string, string> {
    return Object.fromEntries(this.prompts.entries());
  }

  removePrompt(name: string): boolean {
    return this.prompts.delete(name);
  }

  private resolveModel(model?: string): string {
    const explicit = String(model || "").trim();
    if (explicit) return explicit;
    return this.modelId;
  }
}

function ensureUserTurn(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.some((message) => message.role === "user")) return messages;
  return [...messages, { role: "user", content: "." }];
}

function convertMessages(
  messages: TextMessage[] | MultimodalMessage[],
): UnifiedMessage[] {
  if (messages.length === 0) return [];
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return {
        role: message.role,
        content: message.content,
      };
    }
    return {
      role: message.role,
      content: message.content.map((item) =>
        item.type === "text"
          ? { type: "text" as const, text: item.text || "" }
          : {
              type: "image" as const,
              url: item.image_url?.url || "",
              detail: item.image_url?.detail,
            },
      ),
    };
  });
}

function toUnifiedMessages(messages: any[]): UnifiedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return { role: "user", content: String(message ?? "") };
    }
    const role = normalizeRole(message.role);
    if (role === "tool") {
      return {
        role: "tool",
        content: contentToText(message.content),
        toolCallId: String(message.tool_call_id || message.toolCallId || ""),
        name: typeof message.name === "string" ? message.name : undefined,
      };
    }
    if (role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
            .map((tc: any) => ({
              id: String(tc.id || ""),
              name: String(tc.function?.name || tc.name || ""),
              arguments: String(
                tc.function?.arguments ||
                  (typeof tc.arguments === "string"
                    ? tc.arguments
                    : JSON.stringify(tc.arguments || {})),
              ),
            }))
            .filter((tc: any) => tc.name)
        : message.toolCalls;
      return {
        role: "assistant",
        content:
          typeof message.content === "string" || Array.isArray(message.content)
            ? message.content
            : contentToText(message.content),
        toolCalls,
        responseItems: Array.isArray(message.response_items)
          ? message.response_items
          : Array.isArray(message.responseItems)
            ? message.responseItems
            : undefined,
      };
    }
    if (typeof message.content === "string" || Array.isArray(message.content)) {
      if (Array.isArray(message.content)) {
        return {
          role,
          content: message.content.map((part: any) => {
            if (part?.type === "text") {
              return { type: "text" as const, text: String(part.text || "") };
            }
            if (part?.type === "image_url") {
              return {
                type: "image" as const,
                url: String(part.image_url?.url || part.url || ""),
                detail: part.image_url?.detail,
              };
            }
            if (part?.type === "image") {
              return {
                type: "image" as const,
                url: String(part.url || ""),
                mediaType: part.mediaType,
                detail: part.detail,
              };
            }
            if (part?.type === "video_url" || part?.type === "video") {
              return {
                type: "video" as const,
                url: String(part.video_url?.url || part.url || ""),
                detail: part.video_url?.detail || part.detail,
              };
            }
            return { type: "text" as const, text: JSON.stringify(part) };
          }),
        };
      }
      return { role, content: message.content };
    }
    return { role, content: contentToText(message.content) };
  });
}

function toUnifiedTools(tools?: any[]): UnifiedToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .map((tool) => {
      if (tool?.function) {
        return {
          name: String(tool.function.name || ""),
          description: String(tool.function.description || ""),
          parameters: tool.function.parameters || {
            type: "object",
            properties: {},
          },
        };
      }
      if (tool?.name) {
        return {
          name: String(tool.name || ""),
          description: String(tool.description || ""),
          parameters: tool.parameters ||
            tool.input_schema || {
              type: "object",
              properties: {},
            },
        };
      }
      return null;
    })
    .filter(Boolean) as UnifiedToolDefinition[];
}

function normalizeRole(role: unknown): UnifiedMessage["role"] {
  if (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  ) {
    return role;
  }
  if (role === "model") return "assistant";
  return "user";
}

function buildAssistantRaw(
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): any {
  if (toolCalls.length === 0) return { role: "assistant", content };
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.arguments },
    })),
  };
}

export type { AIInstance };
