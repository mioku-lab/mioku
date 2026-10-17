import type {
  AITool,
  ChatRuntimeInformationRequestOptions,
  ChatRuntimeNoticeOptions,
  ChatRuntimePromptInjection,
  ChatRuntimeResult,
  ChatRuntimeCollectedInfo,
} from "mioku";
import type { ChatPluginContext, ChatRuntime } from "../context";
import type { ChatConfig } from "../types";
import { executeChatRuntimeRequest } from "../core/chat-turn";

function resolveRuntimeGroupId(
  options: ChatRuntimeNoticeOptions | ChatRuntimeInformationRequestOptions,
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

export function createChatRuntime(
  pluginCtx: ChatPluginContext,
  getConfig: (groupId?: string) => Promise<ChatConfig>,
): ChatRuntime {
  return {
    async requestInformation(
      options: ChatRuntimeInformationRequestOptions,
    ): Promise<ChatRuntimeResult> {
      let collectedInfo: ChatRuntimeCollectedInfo | null = null;
      const toolName = options.toolName || "submit_requested_information";
      const extraTools: AITool[] = [
        {
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
          handler: async (args) => {
            collectedInfo = {
              data: args?.data,
              isComplete: args?.isComplete,
              confidence: args?.confidence,
              notes: args?.notes,
            };
            return { success: true, accepted: true, collectedInfo };
          },
        },
      ];

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

      const result = await executeChatRuntimeRequest(
        {
          ...options,
          config: await getConfig(resolveRuntimeGroupId(options)),
          targetMessageContent: options.targetMessage,
          promptInjections,
          extraTools,
          send: options.send,
          replyContextType: "reply",
        },
        pluginCtx,
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

      return executeChatRuntimeRequest(
        {
          ...options,
          config: await getConfig(resolveRuntimeGroupId(options)),
          targetMessageContent: options.instruction,
          promptInjections,
          send: options.send,
          replyContextType: "reply",
        },
        pluginCtx,
      );
    },
  };
}
