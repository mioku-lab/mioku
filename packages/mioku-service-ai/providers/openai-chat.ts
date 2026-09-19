import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { extractUsageTokens } from "../usage/tracker";
import type {
  AIModelDescriptor,
  ProviderCompleteOptions,
  ProviderCompleteResponse,
  UnifiedMessage,
  UnifiedToolCall,
  UnifiedToolDefinition,
} from "../types";
import {
  BaseProviderClient,
  contentToText,
  markStablePrefixCacheable,
  preferCache,
  toModelDescriptor,
  toOpenAIReasoningEffort,
} from "./base";

export class OpenAIChatProvider extends BaseProviderClient {
  private client: OpenAI;

  constructor(provider: ConstructorParameters<typeof BaseProviderClient>[0]) {
    super(provider);
    this.client = new OpenAI({
      baseURL: provider.apiUrl,
      apiKey: provider.apiKey,
      defaultHeaders: this.headers,
    });
  }

  async listModels(): Promise<AIModelDescriptor[]> {
    try {
      const response = await this.client.models.list();
      const items = Array.isArray((response as any)?.data)
        ? (response as any).data
        : [];
      return items
        .map((item: any) => String(item?.id || "").trim())
        .filter(Boolean)
        .map((modelId: string) => toModelDescriptor(this.provider, modelId));
    } catch {
      return [];
    }
  }

  async complete(
    options: ProviderCompleteOptions,
  ): Promise<ProviderCompleteResponse> {
    const prepared = preferCache(options)
      ? markStablePrefixCacheable(options.messages, options.tools)
      : { messages: options.messages, tools: options.tools };

    const messages = toOpenAIMessages(prepared.messages, options.systemPrompt);
    const tools = toOpenAITools(prepared.tools);
    const reasoningEffort = toOpenAIReasoningEffort(options.thinkingLevel);

    if (options.stream) {
      return this.completeStream(options, messages, tools, reasoningEffort);
    }

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      ...(options.maxTokens != null && { max_tokens: options.maxTokens }),
      // xhigh 仅部分新模型支持，SDK 类型未收录，这里透传给服务端
      ...(reasoningEffort
        ? { reasoning_effort: reasoningEffort as unknown as string }
        : {}),
    } as any, { signal: options.abortSignal } as any);

    const message = response.choices[0]?.message;
    const content = extractTextContent(message?.content);
    const reasoning =
      (message as any)?.reasoning_content ||
      (message as any)?.reasoning ||
      null;
    const toolCalls = (message?.tool_calls || [])
      .filter((tc: any) => tc?.type === "function" || tc?.function)
      .map((tc: any) => ({
        id: String(tc.id || ""),
        name: String(tc.function?.name || ""),
        arguments: String(tc.function?.arguments || "{}"),
      }))
      .filter((tc: UnifiedToolCall) => tc.name);

    return {
      content,
      reasoning: typeof reasoning === "string" ? reasoning : null,
      toolCalls,
      usage: extractUsageTokens(response),
      raw: message,
    };
  }

  private async completeStream(
    options: ProviderCompleteOptions,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    reasoningEffort?: ReturnType<typeof toOpenAIReasoningEffort>,
  ): Promise<ProviderCompleteResponse> {
    const stream = await (this.client.chat.completions.create({
      model: options.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      stream: true,
      ...(options.maxTokens != null && { max_tokens: options.maxTokens }),
      ...(reasoningEffort
        ? { reasoning_effort: reasoningEffort as unknown as string }
        : {}),
    } as any, { signal: options.abortSignal } as any) as any);

    let content = "";
    let reasoning = "";
    let usage = extractUsageTokens(undefined);
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream as AsyncIterable<any>) {
      const chunkUsage = extractUsageTokens(chunk);
      if (chunkUsage) usage = chunkUsage;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;

      const textDelta = extractTextDelta(delta.content);
      if (textDelta) {
        content += textDelta;
        await options.onTextDelta?.(textDelta);
      }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
        reasoning += delta.reasoning;
      }

      for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index =
          typeof item?.index === "number" && item.index >= 0 ? item.index : 0;
        const acc = toolCallsByIndex.get(index) || {
          id: "",
          name: "",
          arguments: "",
        };
        if (typeof item?.id === "string" && item.id) acc.id = item.id;
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
      usage,
      raw: buildAssistantRaw(content, toolCalls),
    };
  }
}

function toOpenAIMessages(
  messages: UnifiedMessage[],
  systemPrompt?: string,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  if (systemPrompt?.trim()) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const message of messages) {
    if (message.role === "system") {
      result.push({
        role: "system",
        content: contentToText(message.content),
      });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        content: contentToText(message.content),
        tool_call_id: message.toolCallId || "",
      } as ChatCompletionMessageParam);
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls || [];
      if (toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: contentToText(message.content) || null,
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        } as ChatCompletionMessageParam);
      } else {
        result.push({
          role: "assistant",
          content: contentToText(message.content),
        });
      }
      continue;
    }

    if (typeof message.content === "string") {
      result.push({ role: "user", content: message.content });
      continue;
    }
    result.push({
      role: "user",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : part.type === "image"
            ? {
                type: "image_url" as const,
                image_url: {
                  url: part.url,
                  detail: part.detail ?? "auto",
                },
              }
            : {
                type: "video_url" as const,
                video_url: {
                  url: part.url,
                  detail: part.detail ?? "auto",
                },
              },
      ) as any,
    });
  }
  return result;
}

function toOpenAITools(tools?: UnifiedToolDefinition[]): ChatCompletionTool[] {
  if (!tools?.length) return [];
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolParameters(tool.parameters),
    },
  }));
}

function normalizeToolParameters(parameters: unknown): Record<string, unknown> {
  const raw =
    parameters && typeof parameters === "object"
      ? ({ ...(parameters as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const propertiesRaw = raw.properties;
  const properties =
    propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)
      ? ({ ...(propertiesRaw as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  if (Object.keys(properties).length === 0) {
    properties.reason = {
      type: "string",
      description: "Optional reason for calling this tool",
    };
  }

  const required = Array.isArray(raw.required)
    ? (raw.required as unknown[]).filter((item) => typeof item === "string")
    : [];

  return {
    ...raw,
    type: "object",
    properties,
    required,
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
}

function extractTextDelta(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function buildAssistantRaw(
  content: string,
  toolCalls: UnifiedToolCall[],
): ChatCompletionMessageParam {
  if (toolCalls.length === 0) return { role: "assistant", content };
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: { name: toolCall.name, arguments: toolCall.arguments },
    })),
  } as ChatCompletionMessageParam;
}
