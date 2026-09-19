import OpenAI from "openai";
import { logger } from "mioku";
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

export class OpenAIResponseProvider extends BaseProviderClient {
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

    const { instructions, input } = toResponseInput(
      prepared.messages,
      options.systemPrompt,
    );
    const tools = toResponseTools(prepared.tools);
    const reasoningEffort = toOpenAIReasoningEffort(options.thinkingLevel);
    const body: Record<string, unknown> = {
      model: options.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.maxTokens != null
        ? { max_output_tokens: options.maxTokens }
        : {}),
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    };

    if (options.stream) {
      return this.completeStream(options, body);
    }

    try {
      const response = await this.createResponse(body, options.abortSignal);
      return parseResponseResult(response, options);
    } catch (error) {
      logResponseApiFailure(error, body);
      throw error;
    }
  }

  private async completeStream(
    options: ProviderCompleteOptions,
    body: Record<string, unknown>,
  ): Promise<ProviderCompleteResponse> {
    const streamBody = { ...body, stream: true };
    try {
      const stream = await this.createResponse(streamBody, options.abortSignal);
      let content = "";
      let reasoning = "";
      let usage = extractUsageTokens(undefined);
      let responseItems: any[] | undefined;
      const toolCallsByIndex = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const event of stream as AsyncIterable<any>) {
        const type = String(event?.type || "");
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          content += event.delta;
          void options.onTextDelta?.(event.delta);
        }
        if (
          type === "response.reasoning_text.delta" &&
          typeof event.delta === "string"
        ) {
          reasoning += event.delta;
        }
        if (
          type === "response.output_item.added" &&
          event?.item?.type === "function_call"
        ) {
          const index =
            typeof event.output_index === "number" ? event.output_index : 0;
          const acc = toolCallsByIndex.get(index) || {
            id: "",
            name: "",
            arguments: "",
          };
          if (typeof event.item.call_id === "string" && event.item.call_id) {
            acc.id = event.item.call_id;
          }
          if (typeof event.item.id === "string" && event.item.id && !acc.id) {
            acc.id = event.item.id;
          }
          if (typeof event.item.name === "string" && event.item.name) {
            acc.name = event.item.name;
          }
          toolCallsByIndex.set(index, acc);
        }
        if (type === "response.function_call_arguments.delta") {
          const index =
            typeof event.output_index === "number" ? event.output_index : 0;
          const acc = toolCallsByIndex.get(index) || {
            id: "",
            name: "",
            arguments: "",
          };
          if (typeof event.item_id === "string" && event.item_id && !acc.id) {
            acc.id = event.item_id;
          }
          if (typeof event.delta === "string") acc.arguments += event.delta;
          toolCallsByIndex.set(index, acc);
        }
        if (type === "response.completed" && event?.response) {
          usage = extractUsageTokens(event.response) || usage;
          responseItems = Array.isArray(event.response.output)
            ? event.response.output
            : undefined;
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
        raw: buildAssistantRaw(content, toolCalls, responseItems),
      };
    } catch (error) {
      logResponseApiFailure(error, streamBody);
      throw error;
    }
  }

  private async createResponse(
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<any> {
    logResponseApiRequest(body);
    const response = await (this.client as any).responses.create(body, {
      signal: abortSignal,
    });
    logResponseApiResult(response);
    return response;
  }
}

function logResponseApiRequest(body: Record<string, unknown>): void {
  if (process.env.MIOKU_AI_RESPONSE_DEBUG !== "1") return;
  logger.debug(
    `[ai][openai-response] request ${JSON.stringify(summarizeResponseRequest(body))}`,
  );
}

function logResponseApiResult(response: any): void {
  if (process.env.MIOKU_AI_RESPONSE_DEBUG !== "1") return;
  const output = Array.isArray(response?.output) ? response.output : [];
  logger.debug(
    `[ai][openai-response] response ${JSON.stringify({
      id: response?.id,
      status: response?.status,
      output: output.map((item: any) => ({
        type: item?.type,
        id: item?.id,
        callId: item?.call_id,
        name: item?.name,
      })),
    })}`,
  );
}

function logResponseApiFailure(error: unknown, body: Record<string, unknown>): void {
  const apiError = error as Record<string, any>;
  logger.error(
    `[ai][openai-response] request failed ${JSON.stringify({
      request: summarizeResponseRequest(body),
      error: {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        status: apiError?.status,
        code: apiError?.code,
        type: apiError?.type,
        requestId: apiError?.request_id,
        response: summarizeErrorBody(apiError?.error),
        headers: pickResponseHeaders(apiError?.headers),
      },
    })}`,
  );
}

function summarizeResponseRequest(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    model: body.model,
    stream: body.stream === true,
    instructionLength:
      typeof body.instructions === "string" ? body.instructions.length : 0,
    input: input.map((item: any) => ({
      type: item?.type || "message",
      role: item?.role,
      callId: item?.call_id,
      name: item?.name,
      contentLength: responseInputContentLength(item?.content ?? item?.output),
      argumentsLength:
        typeof item?.arguments === "string" ? item.arguments.length : undefined,
    })),
    tools: tools.map((tool: any) => tool?.name).filter(Boolean),
  };
}

function responseInputContentLength(content: unknown): number | undefined {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return undefined;
  return content.reduce(
    (total, part: any) => total + String(part?.text || part?.url || "").length,
    0,
  );
}

function summarizeErrorBody(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const error = value as Record<string, unknown>;
  return {
    message: error.message,
    type: error.type,
    code: error.code,
    param: error.param,
  };
}

function pickResponseHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const values: Record<string, unknown> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      values[key] = value;
    });
  } else {
    Object.assign(values, headers);
  }
  const allowed = ["content-type", "server", "x-request-id", "cf-ray"];
  const selected = Object.fromEntries(
    allowed.flatMap((name) => {
      const value = values[name] ?? values[name.toUpperCase()];
      return typeof value === "string" ? [[name, value]] : [];
    }),
  );
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function toResponseInput(
  messages: UnifiedMessage[],
  systemPrompt?: string,
): { instructions?: string; input: any[] } {
  const systemParts: string[] = [];
  if (systemPrompt?.trim()) systemParts.push(systemPrompt.trim());
  const input: any[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(contentToText(message.content));
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId || "",
        output: contentToText(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      if (message.responseItems?.length) {
        input.push(...message.responseItems);
        continue;
      }
      if (message.toolCalls?.length) {
        for (const toolCall of message.toolCalls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
        }
      }
      const text = contentToText(message.content);
      if (text) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }

    if (typeof message.content === "string") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }

    input.push({
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "input_text", text: part.text };
        }
        if (part.type === "image") {
          return { type: "input_image", image_url: part.url };
        }
        return { type: "input_file", file_url: part.url };
      }),
    });
  }

  return {
    instructions: systemParts.filter(Boolean).join("\n\n") || undefined,
    input,
  };
}

function toResponseTools(tools?: UnifiedToolDefinition[]): any[] {
  if (!tools?.length) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function parseResponseResult(
  response: any,
  options: ProviderCompleteOptions,
): ProviderCompleteResponse {
  let content = "";
  let reasoning = "";
  const toolCalls: UnifiedToolCall[] = [];

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type === "message") {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const part of parts) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          content += part.text;
        }
        if (part?.type === "refusal" && typeof part.refusal === "string") {
          content += part.refusal;
        }
      }
    }
    if (item?.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id || item.id || ""),
        name: String(item.name || ""),
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || {}),
      });
    }
    if (item?.type === "reasoning") {
      const parts = Array.isArray(item.summary) ? item.summary : [];
      for (const part of parts) {
        if (typeof part?.text === "string") reasoning += part.text;
      }
    }
  }

  if (!content && typeof response?.output_text === "string") {
    content = response.output_text;
  }

  if (content && options.onTextDelta) {
    void options.onTextDelta(content);
  }

  return {
    content,
    reasoning: reasoning || null,
    toolCalls: toolCalls.filter((item) => item.name),
    usage: extractUsageTokens(response),
    raw: buildAssistantRaw(
      content,
      toolCalls.filter((item) => item.name),
      output,
    ),
  };
}

function buildAssistantRaw(
  content: string,
  toolCalls: UnifiedToolCall[],
  responseItems?: any[],
): any {
  const raw: any = {
    role: "assistant",
    content,
  };
  if (toolCalls.length > 0) {
    raw.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.arguments },
    }));
  }
  if (responseItems?.length) raw.response_items = responseItems;
  return raw;
}
