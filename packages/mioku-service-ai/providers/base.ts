import type {
  AIModelDescriptor,
  AIProtocol,
  AIProviderConfig,
  AIThinkingLevel,
  ProviderClient,
  ProviderCompleteOptions,
  ProviderCompleteResponse,
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedToolDefinition,
} from "../types";

export const DEFAULT_API_URLS: Record<AIProviderConfig["protocol"], string> = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-response": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/**
 * OpenAI 系（chat / responses）的 reasoning effort 映射：
 * - off 不下发参数（保留服务商默认行为）
 * */
export function toOpenAIReasoningEffort(
  level?: AIThinkingLevel,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  switch (level) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
    default:
      return undefined;
  }
}

/** Anthropic thinking budget_tokens 映射（off 不开启 thinking） */
export function toAnthropicThinkingBudget(
  level?: AIThinkingLevel,
): number | undefined {
  switch (level) {
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
      return 24576;
    case "max":
      return 32768;
    default:
      return undefined;
  }
}

/**
 * Gemini thinkingBudget 映射（gemini 协议最高只到 high）。
 * off → 0 表示关闭思考。
 */
export function toGeminiThinkingBudget(
  level?: AIThinkingLevel,
): number | undefined {
  switch (level) {
    case "off":
      return 0;
    case "low":
      return 1024;
    case "medium":
      return 8192;
    case "high":
    case "xhigh":
    case "max":
      return 24576;
    default:
      return undefined;
  }
}

export function preferCache(options: ProviderCompleteOptions): boolean {
  return options.cachePreference !== "none";
}

export function extractSystemText(messages: UnifiedMessage[]): {
  system: string;
  rest: UnifiedMessage[];
} {
  const systemParts: string[] = [];
  const rest: UnifiedMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      rest.push(message);
      continue;
    }
    systemParts.push(contentToText(message.content));
  }
  return {
    system: systemParts.filter(Boolean).join("\n\n"),
    rest,
  };
}

export function contentToText(
  content: string | UnifiedContentPart[] | undefined | null,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function markStablePrefixCacheable(
  messages: UnifiedMessage[],
  tools?: UnifiedToolDefinition[],
): {
  messages: UnifiedMessage[];
  tools?: UnifiedToolDefinition[];
} {
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "system") return message;
    if (typeof message.content === "string") {
      return {
        ...message,
        content: [
          { type: "text" as const, text: message.content, cacheable: true },
        ],
      };
    }
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part, partIndex, arr) =>
        part.type === "text" && (index === 0 || partIndex === arr.length - 1)
          ? { ...part, cacheable: true }
          : part,
      ),
    };
  });

  const nextTools = tools?.map((tool, index, arr) =>
    index === arr.length - 1 ? { ...tool, cacheable: true } : tool,
  );

  return { messages: nextMessages, tools: nextTools };
}

export function guessCapabilities(
  modelId: string,
): AIModelDescriptor["capabilities"] {
  const id = modelId.toLowerCase();
  const capabilities: AIModelDescriptor["capabilities"] = ["text"];
  if (
    /vision|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|doubao|qwen-vl|llava|omni/i.test(
      id,
    )
  ) {
    capabilities.push("vision");
  }
  if (!/embed|tts|whisper|dall-e|image/i.test(id)) {
    capabilities.push("tool-use");
  }
  if (/o1|o3|o4|reason|r1|thinking|opus/i.test(id)) {
    capabilities.push("reasoning");
  }
  return capabilities;
}

export function toModelDescriptor(
  provider: AIProviderConfig,
  modelId: string,
  name?: string,
  isCustom = false,
): AIModelDescriptor {
  return {
    id: `${provider.id}/${modelId}`,
    providerId: provider.id,
    modelId,
    name: name || modelId,
    capabilities: guessCapabilities(modelId),
    isCustom,
  };
}

export abstract class BaseProviderClient implements ProviderClient {
  constructor(protected readonly provider: AIProviderConfig) {}

  abstract listModels(): Promise<AIModelDescriptor[]>;
  abstract complete(
    options: ProviderCompleteOptions,
  ): Promise<ProviderCompleteResponse>;

  protected get headers(): Record<string, string> {
    return { ...(this.provider.headers || {}) };
  }
}
