import Anthropic from "@anthropic-ai/sdk";
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
  extractSystemText,
  markStablePrefixCacheable,
  preferCache,
  toAnthropicThinkingBudget,
  toModelDescriptor,
} from "./base";

const ANTHROPIC_BUILTIN_MODELS = [
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-latest",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-haiku-20240307",
];

export class AnthropicProvider extends BaseProviderClient {
  private client: Anthropic;

  constructor(provider: ConstructorParameters<typeof BaseProviderClient>[0]) {
    super(provider);
    this.client = new Anthropic({
      apiKey: provider.apiKey,
      baseURL: provider.apiUrl || undefined,
      defaultHeaders: this.headers,
    });
  }

  async listModels(): Promise<AIModelDescriptor[]> {
    return ANTHROPIC_BUILTIN_MODELS.map((modelId) =>
      toModelDescriptor(this.provider, modelId),
    );
  }

  async complete(
    options: ProviderCompleteOptions,
  ): Promise<ProviderCompleteResponse> {
    const prepared = preferCache(options)
      ? markStablePrefixCacheable(options.messages, options.tools)
      : { messages: options.messages, tools: options.tools };

    const { system, rest } = extractSystemText(prepared.messages);
    const systemText = [options.systemPrompt, system].filter(Boolean).join("\n\n");
    const messages = toAnthropicMessages(rest);
    const tools = toAnthropicTools(prepared.tools, preferCache(options));
    const thinkingBudget = toAnthropicThinkingBudget(options.thinkingLevel);

    const body: Anthropic.MessageCreateParams = {
      model: options.model,
      messages,
      // Anthropic 要求 max_tokens 必须大于 thinking.budget_tokens
      max_tokens:
        thinkingBudget != null
          ? Math.max(options.maxTokens ?? 4096, thinkingBudget + 1024)
          : (options.maxTokens ?? 4096),
      // Anthropic 要求开启 thinking 时 temperature 必须为 1
      temperature: thinkingBudget != null ? 1 : options.temperature,
      ...(thinkingBudget != null
        ? {
            thinking: {
              type: "enabled" as const,
              budget_tokens: thinkingBudget,
            },
          }
        : {}),
      ...(systemText
        ? {
            system: preferCache(options)
              ? [
                  {
                    type: "text" as const,
                    text: systemText,
                    cache_control: { type: "ephemeral" as const },
                  },
                ]
              : systemText,
          }
        : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };

    if (options.stream) {
      return this.completeStream(options, body);
    }

    const response = await this.client.messages.create(body, {
      signal: options.abortSignal,
    });
    return parseAnthropicMessage(response);
  }

  private async completeStream(
    options: ProviderCompleteOptions,
    body: Anthropic.MessageCreateParams,
  ): Promise<ProviderCompleteResponse> {
    const stream = this.client.messages.stream(body, {
      signal: options.abortSignal,
    });
    let content = "";
    let reasoning = "";
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const event of stream as any) {
      if (event?.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          toolCallsByIndex.set(event.index ?? 0, {
            id: String(block.id || ""),
            name: String(block.name || ""),
            arguments: "",
          });
        }
      }
      if (event?.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          void options.onTextDelta?.(delta.text);
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          reasoning += delta.thinking;
        }
        if (delta?.type === "input_json_delta") {
          const acc = toolCallsByIndex.get(event.index ?? 0) || {
            id: "",
            name: "",
            arguments: "",
          };
          acc.arguments += String(delta.partial_json || "");
          toolCallsByIndex.set(event.index ?? 0, acc);
        }
      }
    }

    const finalMessage = await stream.finalMessage();
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
      usage: extractUsageTokens({
        usage: {
          input_tokens: finalMessage?.usage?.input_tokens,
          output_tokens: finalMessage?.usage?.output_tokens,
          cache_creation_input_tokens:
            finalMessage?.usage?.cache_creation_input_tokens,
          cache_read_input_tokens: finalMessage?.usage?.cache_read_input_tokens,
        },
      }),
      raw: buildAssistantRaw(content, toolCalls),
    };
  }
}

function toAnthropicMessages(messages: UnifiedMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId || "",
            content: contentToText(message.content),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      const text = contentToText(message.content);
      if (text) content.push({ type: "text", text });
      for (const toolCall of message.toolCalls || []) {
        let input: any = {};
        try {
          input = JSON.parse(toolCall.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input,
        });
      }
      result.push({
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      });
      continue;
    }

    if (typeof message.content === "string") {
      result.push({ role: "user", content: message.content });
      continue;
    }

    result.push({
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return part.cacheable
            ? {
                type: "text" as const,
                text: part.text,
                cache_control: { type: "ephemeral" as const },
              }
            : { type: "text" as const, text: part.text };
        }
        if (part.type === "image") {
          if (part.url.startsWith("data:")) {
            const matched = part.url.match(/^data:([^;]+);base64,(.+)$/);
            if (matched) {
              return {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: matched[1] as any,
                  data: matched[2],
                },
              };
            }
          }
          return {
            type: "image" as const,
            source: {
              type: "url" as const,
              url: part.url,
            },
          };
        }
        return {
          type: "text" as const,
          text: `[video] ${part.url}`,
        };
      }),
    });
  }

  return result;
}

function toAnthropicTools(
  tools: UnifiedToolDefinition[] | undefined,
  enableCache: boolean,
): Anthropic.Tool[] {
  if (!tools?.length) return [];
  return tools.map((tool, index, arr) => {
    const base: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    };
    if (enableCache && (tool.cacheable || index === arr.length - 1)) {
      return {
        ...base,
        cache_control: { type: "ephemeral" as const },
      } as Anthropic.Tool;
    }
    return base;
  });
}

function parseAnthropicMessage(response: any): ProviderCompleteResponse {
  let content = "";
  let reasoning = "";
  const toolCalls: UnifiedToolCall[] = [];
  const blocks = Array.isArray(response?.content) ? response.content : [];

  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      content += block.text;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      reasoning += block.thinking;
    }
    if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || ""),
        name: String(block.name || ""),
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  const usage = extractUsageTokens({
    usage: {
      input_tokens: response?.usage?.input_tokens,
      output_tokens: response?.usage?.output_tokens,
      cache_creation_input_tokens: response?.usage?.cache_creation_input_tokens,
      cache_read_input_tokens: response?.usage?.cache_read_input_tokens,
    },
  });

  return {
    content,
    reasoning: reasoning || null,
    toolCalls,
    usage,
    raw: buildAssistantRaw(content, toolCalls),
  };
}

function buildAssistantRaw(
  content: string,
  toolCalls: UnifiedToolCall[],
): { role: "assistant"; content: string; tool_calls?: any[] } {
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
