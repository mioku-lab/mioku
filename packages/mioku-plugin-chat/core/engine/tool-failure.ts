import type { AIInstance, AIUsageContext, ToolCallRecord } from "mioku";
import type { TargetMessage, ToolContext } from "../../types";
import { isRecord, readTrimmedString, toOptionalId } from "../../utils/record";
import { cleanMarkers } from "./reply-text";

const TOOL_FAILURE_FALLBACK =
  "我刚刚查这条信息时出了点问题，你可以换个关键词再试试，或者给我更具体一点的线索。";

export function buildUsageContext(
  toolCtx: ToolContext,
  targetMessage: TargetMessage,
  extra: Pick<AIUsageContext, "usageId" | "source">,
): AIUsageContext {
  return {
    ...extra,
    botId: toOptionalId(toolCtx.event?.self_id),
    groupId: toolCtx.groupId,
    groupName: readTrimmedString(toolCtx.event, "group_name"),
    userId: toolCtx.userId,
    userName: targetMessage.userName,
    sessionId: toolCtx.sessionId,
  };
}

export function isToolErrorResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result.error) return true;
  return result.success === false;
}

/** 工具都失败且模型没给正文时，补一条自然的兜底回复 */
export async function generateToolFailureReply(
  ai: AIInstance,
  toolCtx: ToolContext,
  systemPrompt: string,
  targetMessage: TargetMessage,
  failedToolCalls: ToolCallRecord[],
): Promise<string> {
  const failedSummary = failedToolCalls
    .map((item) => {
      const raw =
        typeof item.result === "string"
          ? item.result
          : JSON.stringify(item.result);
      return `- ${item.name}: ${raw}`;
    })
    .join("\n");
  const userPrompt = `用户原始消息：${targetMessage.content}

补充上下文：你刚才尝试调用工具，但以下工具失败了：
${failedSummary}

请基于当前会话的人设与语气，给用户一条自然、简短的回复。
要求：
- 可以简要提到“刚刚没查到/调用失败”，但不要泄露内部系统细节。
- 给出可执行的下一步建议（如补充关键词、提供更具体链接、稍后再试）。
- 直接输出最终回复文本，不要解释你在做什么。`;

  try {
    const retry = await ai.complete({
      model: toolCtx.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      usageContext: buildUsageContext(toolCtx, targetMessage, {
        source: "chat.tool-failure",
      }),
      temperature: Math.max(0.2, Math.min(0.8, toolCtx.config.temperature)),
      max_tokens: 120,
    });

    const text = cleanMarkers(retry.content || "");
    if (text) return text;
  } catch (err) {
    toolCtx.ctx.logger.warn(
      `[chat-engine] Failed to generate tool-failure fallback reply: ${err}`,
    );
  }

  return TOOL_FAILURE_FALLBACK;
}
