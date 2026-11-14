import type {
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { isRecord } from "../utils/record";

export type { ChatCompletionMessageParam };

/** 部分多模态模型支持的视频输入，OpenAI 类型里没有 */
export interface VideoUrlContentPart {
  type: "video_url";
  video_url: { url: string };
}

export type ModelContentPart = ChatCompletionContentPart | VideoUrlContentPart;

export type ModelMessage =
  | ChatCompletionMessageParam
  | { role: "user"; content: ModelContentPart[] };

export function textPart(text: string): ChatCompletionContentPartText {
  return { type: "text", text };
}

export function imagePart(
  url: string,
  detail?: ChatCompletionContentPartImage.ImageURL["detail"],
): ChatCompletionContentPartImage {
  return detail
    ? { type: "image_url", image_url: { url, detail } }
    : { type: "image_url", image_url: { url } };
}

/** 模型返回的协议消息只保留合法的对话消息 */
export function isChatMessageParam(
  value: unknown,
): value is ChatCompletionMessageParam {
  if (!isRecord(value)) return false;
  const role = value.role;
  return (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "developer" ||
    role === "function"
  );
}

/** 消息内容里的纯文本部分 */
export function contentText(
  content: ChatCompletionMessageParam["content"] | undefined,
  separator = "\n",
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join(separator);
}
