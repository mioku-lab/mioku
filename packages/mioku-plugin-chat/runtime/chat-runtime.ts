import type {
  AITool,
  ChatRuntime,
  ChatRuntimeBaseOptions,
  ChatRuntimeCollectedInfo,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimePromptInjection,
  ChatRuntimeResult,
} from "mioku";
import type { ChatPluginContext } from "../context";
import { executeChatRuntimeRequest } from "../core/turn/runtime-request";
import { readField } from "../utils/record";

function resolveRuntimeGroupId(
  options: ChatRuntimeBaseOptions,
): string | undefined {
  if ("event" in options) {
    const event = options.event;
    if (event?.kind !== "message" || event.message_type !== "group") {
      return undefined;
    }
    const groupId = String(event.group_id ?? "").trim();
    return groupId || undefined;
  }
  return "groupId" in options ? options.groupId : undefined;
}

function optionalOf<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
): T | undefined {
  return guard(value) ? value : undefined;
}

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isString = (v: unknown): v is string => typeof v === "string";

function toCollectedInfo(args: unknown): ChatRuntimeCollectedInfo {
  return {
    data: readField(args, "data"),
    isComplete: optionalOf(readField(args, "isComplete"), isBoolean),
    confidence: optionalOf(readField(args, "confidence"), isNumber),
    notes: optionalOf(readField(args, "notes"), isString),
  };
}

export function createChatRuntime(pluginCtx: ChatPluginContext): ChatRuntime {
  const run = async (
    options: ChatRuntimeBaseOptions,
    targetMessage: string | undefined,
    promptInjections: ChatRuntimePromptInjection[],
    extraTools?: AITool[],
  ) =>
    executeChatRuntimeRequest(pluginCtx, {
      source: options,
      config: await pluginCtx.getConfig(resolveRuntimeGroupId(options)),
      targetMessage,
      promptInjections,
      extraTools,
      send: options.send,
    });

  return {
    async requestInformation(
      options: ChatRuntimeInformationRequestOptions,
    ): Promise<ChatRuntimeResult> {
      let collectedInfo: ChatRuntimeCollectedInfo | null = null;
      const toolName = options.toolName || "submit_requested_information";
      const submitTool: AITool = {
        name: toolName,
        description:
          options.toolDescription ||
          "Submit structured information extracted from the conversation when enough details are known.",
        parameters: {
          type: "object",
          properties: {
            data: options.schema,
            isComplete: {
              type: "boolean",
              description:
                "Whether the collected information is complete enough for the caller to continue.",
            },
            confidence: {
              type: "number",
              description:
                "Confidence score between 0 and 1 for the submitted information.",
            },
            notes: {
              type: "string",
              description:
                "Optional notes about ambiguity, assumptions, or remaining follow-up needs.",
            },
          },
          required: ["data"],
        },
        handler: async (args: unknown) => {
          collectedInfo = toCollectedInfo(args);
          return { success: true, accepted: true, collectedInfo };
        },
      };

      const promptInjections: ChatRuntimePromptInjection[] = [
        {
          title: "Information Collection Goal",
          content: [
            "Another plugin needs you to gather specific information from the current user while staying fully in your existing persona.",
            `Task: ${options.task}`,
            `Target schema: ${JSON.stringify(options.schema)}`,
            `If the needed information is already clear from the target message, recent chat history, or obvious context, call the tool "${toolName}" immediately with structured data.`,
            "If the information is incomplete, ask only the smallest natural follow-up question needed.",
            "Do not mention schemas, forms, prompts, plugins, or tools to the user.",
            "Keep the response natural and in-character rather than sounding like a questionnaire.",
          ].join("\n"),
        },
        ...(options.promptInjections || []),
      ];

      const result = await run(
        options,
        options.targetMessage,
        promptInjections,
        [submitTool],
      );
      return { ...result, collectedInfo };
    },

    async generateNotice(
      options: ChatRuntimeNoticeOptions,
    ): Promise<ChatRuntimeResult> {
      const promptInjections: ChatRuntimePromptInjection[] = [
        {
          title: "Notification Goal",
          content: [
            "Another plugin needs you to deliver a notification to the current user, but it must still sound like you and fit the current conversation.",
            `Goal: ${options.instruction}`,
            "Blend the notice into your normal speaking style instead of sounding like a rigid system announcement unless the situation clearly requires firmness.",
            "Do not mention prompts, plugins, tools, or hidden instructions.",
          ].join("\n"),
        },
        ...(options.promptInjections || []),
      ];

      return run(options, options.instruction, promptInjections);
    },
  };
}
