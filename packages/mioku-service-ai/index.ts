import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "mioki";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { AITool, AISkill, MiokuService } from "mioku";
import { createAIUsageStore } from "./usage/store";
import {
  AssistantMessageResult,
  AIInstance,
  AIService,
  ChatRuntime,
  CompleteOptions,
  CompleteResponse,
  MultimodalMessage,
  SessionToolDefinition,
  TextMessage,
  ToolCallRecord,
  TOOL_RESULT_FOLLOWUP_KEY,
  type ToolResultFollowup,
} from "./types";
import type {
  AIUsageCompletionMeta,
  AIUsageContext,
  AIUsageFinalization,
  AIUsageMeasuredTokens,
  AIUsageStore,
} from "./usage/types";

const DEFAULT_CHAT_MODEL = "gemini-3.0-flash-preview";

/**
 * AI 实例实现
 */
class AIInstanceImpl implements AIInstance {
  private client: OpenAI;
  private prompts: Map<string, string> = new Map();
  private readonly globalSkills: Map<string, AISkill>;
  private readonly usageStore: AIUsageStore;
  private usageContext: AIUsageContext | undefined;
  private readonly defaultModel: string | undefined;

  constructor(
    apiUrl: string,
    apiKey: string,
    _modelType: "text" | "multimodal",
    defaultModel: string | undefined,
    globalSkills: Map<string, AISkill>,
    usageStore: AIUsageStore,
  ) {
    this.client = new OpenAI({
      baseURL: apiUrl,
      apiKey: apiKey,
    });
    this.defaultModel = defaultModel;
    this.globalSkills = globalSkills;
    this.usageStore = usageStore;
  }

  async generateText(options: {
    prompt?: string;
    messages: TextMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string> {
    const model = await this.resolveModel(options.model);
    const composed: ChatCompletionMessageParam[] = options.prompt
      ? [{ role: "system", content: options.prompt }, ...options.messages]
      : [...options.messages];

    // Some upstreams reject system-only requests with 400 "chat content is empty".
    // Append a minimal placeholder user turn when the caller didn't provide one.
    const hasUserTurn = composed.some((m) => m.role === "user");
    const messages: ChatCompletionMessageParam[] = hasUserTurn
      ? composed
      : [...composed, { role: "user", content: "." }];

    const response = await this.complete({
      model,
      messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
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
    const model = await this.resolveModel(options.model);
    const convertedMessages: ChatCompletionMessageParam[] =
      options.messages.map((msg) => {
        if (typeof msg.content === "string") {
          return {
            role: msg.role,
            content: msg.content,
          } as ChatCompletionMessageParam;
        } else {
          return {
            role: msg.role,
            content: msg.content.map((item) => {
              if (item.type === "text") {
                return { type: "text" as const, text: item.text || "" };
              } else {
                return {
                  type: "image_url" as const,
                  image_url: item.image_url!,
                };
              }
            }),
          } as ChatCompletionMessageParam;
        }
      });

    const composed: ChatCompletionMessageParam[] = options.prompt
      ? [{ role: "system", content: options.prompt }, ...convertedMessages]
      : convertedMessages;

    const hasUserTurn = composed.some((m) => m.role === "user");
    const messages: ChatCompletionMessageParam[] = hasUserTurn
      ? composed
      : [...composed, { role: "user", content: "." }];

    const response = await this.complete({
      model,
      messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
    });

    return response.content || "";
  }

  async complete(options: CompleteOptions): Promise<CompleteResponse> {
    const model = await this.resolveModel(options.model);
    const tracker = createUsageTracker({
      model,
      stream: Boolean(options.stream),
      context: options.usageContext ?? this.usageContext,
      startedAt: Date.now(),
      initialMessages: options.messages,
      initialTools: options.tools,
      explicitContextTokens: options.usageContextTokens,
      explicitBreakdown: options.usageBreakdown,
      usageStore: this.usageStore,
    });

    try {
      const response =
        (options.executableTools && options.executableTools.length > 0) ||
        options.executableToolsProvider
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
      messages: options.messages,
      tools: options.tools,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens,
      stream: options.stream,
      onTextDelta: options.onTextDelta,
    });
    tracker.recordAssistant(assistant);
    if (assistant.usage) {
      tracker.recordMeasuredTokens(assistant.usage);
    }

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
    const maxIterations = options.maxIterations ?? 40;
    const allToolCalls: ToolCallRecord[] = [];
    const failedToolCallKeys = new Set<string>();
    const sessionMessages = [...options.messages];
    const turnMessages: ChatCompletionMessageParam[] = [];
    let iterations = 0;
    let content = "";
    let reasoning: string | null = null;
    let raw: ChatCompletionMessageParam = { role: "assistant", content: "" };

    while (iterations < maxIterations) {
      iterations++;
      const currentDefinitions = options.executableToolsProvider
        ? options.executableToolsProvider()
        : (options.executableTools ?? []);
      const toolMap = new Map<string, AITool>();
      const tools: ChatCompletionTool[] = [];
      const followupMessages: ChatCompletionMessageParam[] = [];

      for (const definition of currentDefinitions) {
        toolMap.set(definition.name, definition.tool);
        tools.push({
          type: "function",
          function: {
            name: definition.name,
            description: definition.tool.description,
            parameters: definition.tool.parameters,
          },
        });
      }
      tracker.recordToolDefinitions(tools);

      const assistant = await this.requestAssistantMessage({
        model,
        messages: sessionMessages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens,
        stream: options.stream,
        onTextDelta: options.onTextDelta,
      });
      tracker.recordAssistant(assistant);
      if (assistant.usage) {
        tracker.recordMeasuredTokens(assistant.usage);
      }

      content = assistant.content;
      reasoning = assistant.reasoning;
      raw = assistant.raw;
      sessionMessages.push(assistant.raw);
      turnMessages.push(assistant.raw);

      if (assistant.toolCalls.length === 0) {
        return {
          content,
          reasoning,
          toolCalls: [],
          raw,
          iterations,
          allToolCalls,
          turnMessages,
        };
      }

      for (const toolCall of assistant.toolCalls) {
        const toolName = toolCall.name;
        const tool = toolMap.get(toolName);
        const args = parseToolArguments(toolCall.arguments);
        const callKey = buildToolCallKey(toolName, args);
        let result: any;

        if (!tool) {
          logger.warn(
            `[ai] Tool ${toolName} not found (raw: "${toolName}"). Executable tools: ${[...toolMap.keys()].join(", ") || "(none)"}. Global skills: ${[...this.globalSkills.keys()].join(", ") || "(none)"}`,
          );
          result = { error: `Tool ${toolName} not found` };
        } else if (failedToolCallKeys.has(callKey)) {
          result = {
            success: false,
            error:
              "Tool call skipped: the same tool call with identical arguments already failed in this turn.",
          };
        } else {
          try {
            result = await tool.handler(args);
          } catch (error) {
            logger.error(`Tool ${toolName} execution failed: ${error}`);
            result = { error: String(error) };
          }
        }

        const normalizedResult = normalizeToolResult(result);

        if (isToolErrorResult(normalizedResult.visibleResult)) {
          failedToolCallKeys.add(callKey);
        }

        allToolCalls.push({
          name: toolName,
          arguments: args,
          result: normalizedResult.visibleResult,
        });
        tracker.recordToolCall(toolName);

        const toolMessage = {
          role: "tool",
          content: JSON.stringify(normalizedResult.visibleResult),
          tool_call_id: toolCall.id,
        } as ChatCompletionMessageParam;

        sessionMessages.push(toolMessage);
        turnMessages.push(toolMessage);
        tracker.recordMessage(toolMessage);
        followupMessages.push(...normalizedResult.followupMessages);
      }

      if (followupMessages.length > 0) {
        sessionMessages.push(...followupMessages);
        turnMessages.push(...followupMessages);
        for (const followupMessage of followupMessages) {
          tracker.recordMessage(followupMessage);
        }
      }
    }

    logger.warn(
      `Reached maximum iterations (${maxIterations}) for complete with executable tools`,
    );
    return {
      content: "达到最大迭代次数限制",
      reasoning,
      toolCalls: [],
      raw,
      iterations,
      allToolCalls,
      turnMessages,
    };
  }

  private async requestAssistantMessage(args: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    temperature: number;
    max_tokens?: number;
    stream?: boolean;
    onTextDelta?: (delta: string) => void | Promise<void>;
  }): Promise<AssistantMessageResult> {
    if (args.stream) {
      return this.requestAssistantMessageStream(args);
    }
    return this.requestAssistantMessageNonStream(args);
  }

  private async requestAssistantMessageNonStream(args: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    temperature: number;
    max_tokens?: number;
  }): Promise<AssistantMessageResult> {
    const response = await this.client.chat.completions.create({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      temperature: args.temperature,
      ...(args.max_tokens != null && {
        max_completion_tokens: args.max_tokens,
      }),
    });

    const message = response.choices[0]?.message;
    if (!message) {
      return {
        content: "",
        reasoning: null,
        toolCalls: [],
        raw: { role: "assistant", content: "" },
        usage: extractUsageTokens(response),
      };
    }

    const reasoning =
      (message as any).reasoning_content || (message as any).reasoning || null;
    const toolCalls = (message.tool_calls || [])
      .filter((tc) => tc.type === "function")
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

    return {
      content: extractTextContent(message.content),
      reasoning,
      toolCalls,
      raw: message as ChatCompletionMessageParam,
      usage: extractUsageTokens(response),
    };
  }

  private async requestAssistantMessageStream(args: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    temperature: number;
    max_tokens?: number;
    onTextDelta?: (delta: string) => void | Promise<void>;
  }): Promise<AssistantMessageResult> {
    const stream = await this.client.chat.completions.create({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      temperature: args.temperature,
      stream: true,
      ...(args.max_tokens != null && {
        max_completion_tokens: args.max_tokens,
      }),
    });

    let content = "";
    let reasoning = "";
    let streamUsage: AIUsageMeasuredTokens | undefined;
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream as AsyncIterable<any>) {
      const choice = chunk?.choices?.[0];
      const chunkUsage = extractUsageTokens(chunk);
      if (chunkUsage) {
        streamUsage = mergeMeasuredTokens(streamUsage, chunkUsage);
      }
      const delta = choice?.delta;
      if (!delta) continue;

      const textDelta = extractTextDelta(delta.content);
      if (textDelta) {
        content += textDelta;
        if (args.onTextDelta) {
          await args.onTextDelta(textDelta);
        }
      }

      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
        reasoning += delta.reasoning;
      }

      const deltaToolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : [];
      for (const item of deltaToolCalls) {
        const index =
          typeof item?.index === "number" && item.index >= 0 ? item.index : 0;
        const acc = toolCallsByIndex.get(index) || {
          id: "",
          name: "",
          arguments: "",
        };

        if (typeof item?.id === "string" && item.id) {
          acc.id = item.id;
        }
        if (typeof item?.function?.name === "string" && item.function.name) {
          acc.name += item.function.name;
        }
        if (
          typeof item?.function?.arguments === "string" &&
          item.function.arguments
        ) {
          acc.arguments += item.function.arguments;
        }

        toolCallsByIndex.set(index, acc);
      }
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, item]) => ({
        id: item.id || `tool_call_${index}_${Date.now()}`,
        name: item.name,
        arguments: item.arguments || "{}",
      }))
      .filter((item) => item.name);

    return {
      content,
      reasoning: reasoning || null,
      toolCalls,
      raw: buildAssistantRawMessage(content, toolCalls),
      usage: streamUsage,
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
    const executableTools: SessionToolDefinition[] = [];

    for (const [skillName, skill] of this.globalSkills) {
      for (const tool of skill.tools) {
        executableTools.push({
          name: `${skillName}.${tool.name}`,
          tool: {
            ...tool,
            description: `[${skillName}] ${tool.description}`,
          },
        });
      }
    }

    let messages = this.convertMessages(options.messages);
    if (options.prompt) {
      messages = [{ role: "system", content: options.prompt }, ...messages];
    }

    const response = await this.complete({
      model: options.model,
      messages,
      executableTools,
      temperature: options.temperature,
      maxIterations: options.maxIterations,
    });

    return {
      content: response.content || "",
      iterations: response.iterations ?? 1,
      allToolCalls: response.allToolCalls || [],
    };
  }

  private convertMessages(
    messages: TextMessage[] | MultimodalMessage[],
  ): ChatCompletionMessageParam[] {
    if (messages.length === 0) return [];

    const firstMsg = messages[0];
    if (typeof firstMsg.content === "string") {
      return [...(messages as TextMessage[])];
    } else {
      return (messages as MultimodalMessage[]).map((msg) => {
        if (typeof msg.content === "string") {
          return {
            role: msg.role,
            content: msg.content,
          } as ChatCompletionMessageParam;
        } else {
          return {
            role: msg.role,
            content: msg.content.map((item) => {
              if (item.type === "text") {
                return { type: "text" as const, text: item.text || "" };
              } else {
                return {
                  type: "image_url" as const,
                  image_url: item.image_url!,
                };
              }
            }),
          } as ChatCompletionMessageParam;
        }
      });
    }
  }

  registerPrompt(name: string, prompt: string): boolean {
    if (this.prompts.has(name)) {
      logger.warn(`Prompt ${name} already exists, overwriting`);
    }
    this.prompts.set(name, prompt);
    logger.info(`Prompt ${name} registered successfully`);
    return true;
  }

  getPrompt(name: string): string | undefined {
    return this.prompts.get(name);
  }

  getAllPrompts(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, prompt] of this.prompts.entries()) {
      result[name] = prompt;
    }
    return result;
  }

  removePrompt(name: string): boolean {
    const deleted = this.prompts.delete(name);
    if (deleted) {
      logger.info(`Prompt ${name} removed`);
    }
    return deleted;
  }

  private async resolveModel(model?: string): Promise<string> {
    const explicitModel = String(model || "").trim();
    if (explicitModel) {
      return explicitModel;
    }

    const chatModel = await readChatPrimaryModel();
    return chatModel || DEFAULT_CHAT_MODEL;
  }
}

async function readChatPrimaryModel(): Promise<string | undefined> {
  const configPath = path.join(process.cwd(), "config", "chat", "base.json");

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const model = String(parsed?.model || "").trim();
    return model || undefined;
  } catch {
    return undefined;
  }
}

/**
 * AI 服务实现
 */
class AIServiceImpl implements AIService {
  private instances: Map<string, AIInstance> = new Map();
  private globalSkills: Map<string, AISkill> = new Map();
  private defaultInstanceName: string | null = null;
  private chatRuntime: ChatRuntime | null = null;
  private readonly usageStore: AIUsageStore;

  constructor(usageStore: AIUsageStore) {
    this.usageStore = usageStore;
  }

  async create(options: {
    name: string;
    apiUrl: string;
    apiKey: string;
    modelType: "text" | "multimodal";
    model?: string;
  }): Promise<AIInstance> {
    if (this.instances.has(options.name)) {
      logger.error(`AI instance ${options.name} already exists`);
    }

    const instance = new AIInstanceImpl(
      options.apiUrl,
      options.apiKey,
      options.modelType,
      options.model,
      this.globalSkills,
      this.usageStore,
    );

    this.instances.set(options.name, instance);
    logger.info(`AI instance ${options.name} created successfully`);
    return instance;
  }

  get(name: string): AIInstance | undefined {
    return this.instances.get(name);
  }

  list(): string[] {
    return Array.from(this.instances.keys());
  }

  remove(name: string): boolean {
    const deleted = this.instances.delete(name);
    if (deleted) {
      if (this.defaultInstanceName === name) {
        this.defaultInstanceName = null;
      }
      logger.info(`AI instance ${name} removed`);
    }
    return deleted;
  }

  setDefault(name: string): boolean {
    if (!this.instances.has(name)) {
      logger.warn(`Cannot set default: AI instance ${name} not found`);
      return false;
    }
    this.defaultInstanceName = name;
    logger.info(`Default AI instance set to ${name}`);
    return true;
  }

  getDefault(): AIInstance | undefined {
    if (this.defaultInstanceName) {
      return this.instances.get(this.defaultInstanceName);
    }
    return undefined;
  }

  registerChatRuntime(runtime: ChatRuntime): boolean {
    this.chatRuntime = runtime;
    logger.info("Chat runtime registered successfully");
    return true;
  }

  getChatRuntime(): ChatRuntime | undefined {
    return this.chatRuntime ?? undefined;
  }

  removeChatRuntime(): boolean {
    if (!this.chatRuntime) {
      return false;
    }
    this.chatRuntime = null;
    logger.info("Chat runtime removed");
    return true;
  }

  registerSkill(skill: AISkill): boolean {
    if (this.globalSkills.has(skill.name)) {
      logger.warn(`Skill ${skill.name} already exists, overwriting`);
    }
    this.globalSkills.set(skill.name, skill);
    logger.info(
      `Skill ${skill.name} registered with ${skill.tools.length} tools`,
    );
    return true;
  }

  getSkill(skillName: string): AISkill | undefined {
    return this.globalSkills.get(skillName);
  }

  getAllSkills(): Map<string, AISkill> {
    return this.globalSkills;
  }

  removeSkill(skillName: string): boolean {
    const deleted = this.globalSkills.delete(skillName);
    if (deleted) {
      logger.info(`Skill ${skillName} removed`);
    }
    return deleted;
  }

  getTool(toolName: string): AITool | undefined {
    // 支持两种格式：skillName.toolName 或 toolName
    const parts = toolName.split(".");
    if (parts.length === 2) {
      const [skillName, toolNameOnly] = parts;
      const skill = this.globalSkills.get(skillName);
      return skill?.tools.find((t) => t.name === toolNameOnly);
    } else {
      // 遍历所有 skills 查找工具
      for (const skill of this.globalSkills.values()) {
        const tool = skill.tools.find((t) => t.name === toolName);
        if (tool) return tool;
      }
    }
    return undefined;
  }

  getAllTools(): Map<string, AITool> {
    const allTools = new Map<string, AITool>();
    for (const [skillName, skill] of this.globalSkills) {
      for (const tool of skill.tools) {
        const fullName = `${skillName}.${tool.name}`;
        allTools.set(fullName, tool);
      }
    }
    return allTools;
  }

  getUsageSummary(options: Parameters<AIService["getUsageSummary"]>[0]) {
    return this.usageStore.getSummary(options);
  }

  cleanupUsageStats(retentionMs?: number): number {
    return this.usageStore.cleanup(retentionMs);
  }

  finalizeUsage(usageId: string, finalization: AIUsageFinalization): boolean {
    return this.usageStore.updateFinalization(usageId, finalization);
  }

  dispose(): void {
    this.usageStore.close();
  }
}

function parseToolArguments(raw: string): any {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

interface UsageTracker {
  recordMessage(message: ChatCompletionMessageParam): void;
  recordAssistant(assistant: AssistantMessageResult): void;
  recordMeasuredTokens(tokens: AIUsageMeasuredTokens): void;
  recordToolDefinitions(tools: ChatCompletionTool[]): void;
  recordToolCall(name: string): void;
  finish(success: boolean, errorMessage?: string): void;
}

function createUsageTracker(options: {
  model: string;
  stream: boolean;
  context?: AIUsageContext;
  startedAt: number;
  initialMessages: ChatCompletionMessageParam[];
  initialTools?: ChatCompletionTool[];
  explicitContextTokens?: number;
  explicitBreakdown?: AIUsageFinalization["breakdown"];
  usageStore: AIUsageStore;
}): UsageTracker {
  const messages: AIUsageCompletionMeta["messages"] = [];
  const toolCalls: string[] = [];
  let toolDefinitionTokens = 0;
  let toolUseTokens = 0;
  let measuredTokens: AIUsageMeasuredTokens | undefined;
  let finished = false;

  const recordMessage = (message: ChatCompletionMessageParam): void => {
    const role = normalizeUsageRole(message.role);
    const contentTokens = estimateMessageContentTokens(message);
    messages.push({ role, contentTokens });
    if (role === "tool") {
      toolUseTokens += contentTokens;
    }
  };

  for (const message of options.initialMessages) {
    recordMessage(message);
  }
  if (options.initialTools) {
    toolDefinitionTokens += estimateJsonTokens(options.initialTools);
  }

  return {
    recordMessage,
    recordAssistant(assistant): void {
      recordMessage(assistant.raw);
    },
    recordMeasuredTokens(tokens): void {
      measuredTokens = mergeMeasuredTokens(measuredTokens, tokens);
    },
    recordToolDefinitions(tools): void {
      toolDefinitionTokens += estimateJsonTokens(tools);
    },
    recordToolCall(name): void {
      toolCalls.push(name);
    },
    finish(success, errorMessage): void {
      if (finished) return;
      finished = true;

      const systemPromptTokens = messages
        .filter((message) => message.role === "system")
        .reduce((sum, message) => sum + message.contentTokens, 0);
      const explicitContextTokens =
        typeof options.explicitContextTokens === "number" &&
        Number.isFinite(options.explicitContextTokens)
          ? Math.max(0, Math.floor(options.explicitContextTokens))
          : 0;
      const explicitBreakdown = options.explicitBreakdown;
      const outputTokens = messages
        .filter((message) => message.role === "assistant")
        .reduce((sum, message) => sum + message.contentTokens, 0);
      const inputTokens = messages
        .filter((message) => message.role !== "assistant")
        .reduce((sum, message) => sum + message.contentTokens, 0);
      const finalInputTokens = measuredTokens?.inputTokens ?? inputTokens;
      const finalOutputTokens = measuredTokens?.outputTokens ?? outputTokens;
      const finalSystemPromptTokens =
        normalizeUsageBreakdownValue(explicitBreakdown?.systemPromptTokens) ??
        Math.max(0, systemPromptTokens - explicitContextTokens);
      const finalChatHistoryTokens =
        normalizeUsageBreakdownValue(explicitBreakdown?.chatHistoryTokens) ??
        explicitContextTokens;
      const finalToolDefinitionTokens =
        normalizeUsageBreakdownValue(explicitBreakdown?.toolDefinitionTokens) ??
        toolDefinitionTokens;
      const finalToolUseTokens =
        normalizeUsageBreakdownValue(explicitBreakdown?.toolUseTokens) ??
        toolUseTokens;
      const otherContextTokens =
        normalizeUsageBreakdownValue(explicitBreakdown?.otherContextTokens) ??
        Math.max(
          0,
          finalInputTokens -
            finalSystemPromptTokens -
            finalChatHistoryTokens -
            finalToolDefinitionTokens -
            finalToolUseTokens,
        );
      const adjustedMessages =
        explicitContextTokens > 0
          ? splitExplicitContextTokens(messages, explicitContextTokens)
          : messages;

      options.usageStore.record({
        model: options.model,
        stream: options.stream,
        success,
        errorMessage,
        startedAt: options.startedAt,
        endedAt: Date.now(),
        messages: adjustedMessages,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        cacheWriteTokens: measuredTokens?.cacheWriteTokens ?? 0,
        cacheReadTokens: measuredTokens?.cacheReadTokens ?? 0,
        sentUserMessages: 0,
        sentAssistantMessages: 0,
        systemPromptTokens: finalSystemPromptTokens,
        toolDefinitionTokens: finalToolDefinitionTokens,
        toolUseTokens: finalToolUseTokens,
        chatHistoryTokens: finalChatHistoryTokens,
        otherContextTokens,
        toolCalls,
        context: options.context,
      });
    },
  };
}

function mergeMeasuredTokens(
  current: AIUsageMeasuredTokens | undefined,
  next: AIUsageMeasuredTokens,
): AIUsageMeasuredTokens {
  return {
    inputTokens: sumOptional(current?.inputTokens, next.inputTokens),
    outputTokens: sumOptional(current?.outputTokens, next.outputTokens),
    totalTokens: sumOptional(current?.totalTokens, next.totalTokens),
    cacheWriteTokens: sumOptional(
      current?.cacheWriteTokens,
      next.cacheWriteTokens,
    ),
    cacheReadTokens: sumOptional(current?.cacheReadTokens, next.cacheReadTokens),
  };
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function normalizeUsageBreakdownValue(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function splitExplicitContextTokens(
  messages: AIUsageCompletionMeta["messages"],
  contextTokens: number,
): AIUsageCompletionMeta["messages"] {
  let remaining = contextTokens;
  return messages.map((message) => {
    if (message.role !== "system" || remaining <= 0) {
      return message;
    }

    const moved = Math.min(message.contentTokens, remaining);
    remaining -= moved;
    return {
      ...message,
      contentTokens: Math.max(0, message.contentTokens - moved),
    };
  });
}

function extractUsageTokens(payload: unknown): AIUsageMeasuredTokens | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const promptDetails = firstObject(
    usageRecord.prompt_tokens_details,
    usageRecord.promptTokensDetails,
    usageRecord.input_tokens_details,
    usageRecord.inputTokensDetails,
  );
  const completionDetails = firstObject(
    usageRecord.completion_tokens_details,
    usageRecord.completionTokensDetails,
    usageRecord.output_tokens_details,
    usageRecord.outputTokensDetails,
  );

  const inputTokens = firstNumber(
    usageRecord.prompt_tokens,
    usageRecord.promptTokens,
    usageRecord.input_tokens,
    usageRecord.inputTokens,
  );
  const outputTokens = firstNumber(
    usageRecord.completion_tokens,
    usageRecord.completionTokens,
    usageRecord.output_tokens,
    usageRecord.outputTokens,
  );
  const cacheReadTokens = firstNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cachedTokens,
    promptDetails?.cache_read_input_tokens,
    promptDetails?.cacheReadInputTokens,
    usageRecord.cache_read_input_tokens,
    usageRecord.cacheReadInputTokens,
    usageRecord.cached_tokens,
    usageRecord.cachedTokens,
  );
  const cacheWriteTokens = firstNumber(
    promptDetails?.cache_creation_input_tokens,
    promptDetails?.cacheCreationInputTokens,
    promptDetails?.cache_write_input_tokens,
    promptDetails?.cacheWriteInputTokens,
    usageRecord.cache_creation_input_tokens,
    usageRecord.cacheCreationInputTokens,
    usageRecord.cache_write_input_tokens,
    usageRecord.cacheWriteInputTokens,
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens: firstNumber(
      usageRecord.total_tokens,
      usageRecord.totalTokens,
      usageRecord.total,
    ),
    cacheWriteTokens,
    cacheReadTokens,
  };
}

function firstObject(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numberValue) && numberValue >= 0) {
      return Math.floor(numberValue);
    }
  }
  return undefined;
}

function normalizeUsageRole(role: string): "system" | "user" | "assistant" | "tool" {
  if (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  ) {
    return role;
  }
  return "user";
}

function estimateMessageContentTokens(message: ChatCompletionMessageParam): number {
  return estimateContentTokens((message as { content?: unknown }).content);
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return sum + estimateTextTokens(record.text);
    }
    if (record.type === "image_url") {
      return sum + 85;
    }
    return sum + estimateJsonTokens(record);
  }, 0);
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjkChars = normalized.match(/[\u3400-\u9fff\u3040-\u30ff]/g)?.length || 0;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length || 0;
  const symbols = Math.max(0, normalized.length - cjkChars);
  return Math.max(1, Math.ceil(cjkChars * 0.6 + latinWords * 1.3 + symbols / 6));
}

function isToolErrorResult(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.error) return true;
  return result.success === false;
}

function normalizeToolResult(result: any): {
  visibleResult: any;
  followupMessages: ChatCompletionMessageParam[];
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { visibleResult: result, followupMessages: [] };
  }

  const followup = result[TOOL_RESULT_FOLLOWUP_KEY] as
    | ToolResultFollowup
    | undefined;
  if (
    !followup ||
    !Array.isArray(followup.images) ||
    followup.images.length === 0
  ) {
    return { visibleResult: result, followupMessages: [] };
  }

  const { [TOOL_RESULT_FOLLOWUP_KEY]: _followup, ...visibleResult } = result;
  const content = [
    {
      type: "text" as const,
      text: followup.text || "Use the attached image to answer the request.",
    },
    ...followup.images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image.url,
        detail: image.detail ?? "auto",
      },
    })),
  ];

  return {
    visibleResult,
    followupMessages: [
      {
        role: "user",
        content,
      } as ChatCompletionMessageParam,
    ],
  };
}

function buildToolCallKey(name: string, args: any): string {
  return `${name}:${stableStringify(args ?? {})}`;
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
  );
  return `{${pairs.join(",")}}`;
}

function extractTextContent(
  content: ChatCompletionMessageParam["content"] | null | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(part && part.type === "text");
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractTextDelta(content: any): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || part.type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function buildAssistantRawMessage(
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): ChatCompletionMessageParam {
  if (toolCalls.length === 0) {
    return { role: "assistant", content };
  }

  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    })),
  } as ChatCompletionMessageParam;
}

const aiService: MiokuService = {
  name: "ai",
  version: "1.0.0",
  description:
    "为插件提供完整的ai服务支持，包括ai实例管理，提示词管理，skills管理等",
  api: {} as AIService,

  async init() {
    this.api = new AIServiceImpl(createAIUsageStore());
    logger.info("ai-service 服务已就绪");
  },

  async dispose() {
    const api = this.api as AIService & { dispose?: () => void };
    api.dispose?.();
    logger.info("ai-service 已卸载");
  },
};

export default aiService;
