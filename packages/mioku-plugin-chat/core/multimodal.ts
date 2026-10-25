import type { AIInstance, MiokuContext } from "mioku";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { logger } from "mioku";
import type { ChatTurnEvent } from "../types";
import { prepareImageUrlsForModel } from "./media/image-compress";
import { getSegmentSourceCandidates } from "./media/history-media";
import { imagePart, textPart } from "./model-content";

/**
 * 多模态内容管理器
 * 负责处理图片、视频等多模态内容的描述和分析
 */

/**
 * 图片描述结果
 */
export interface ImageDescriptionResult {
  success: boolean;
  description?: string;
  error?: string;
}

/**
 * 使用多模态工作模型描述图片
 * @param ai AI 实例
 * @param imageUrl 图片 URL
 * @param model 多模态工作模型名称
 * @param context 可选的上下文信息（例如用户的问题）
 * @returns 图片描述结果
 */
export async function describeImage(
  ai: AIInstance,
  imageUrl: string,
  model: string,
  context?: string,
): Promise<ImageDescriptionResult> {
  try {
    // 检查是否为 GIF，如果是则提取三帧
    const { isGifUrl, extractGifFrames } =
      await import("./media/gif-extractor");
    let imageUrls: string[] = [imageUrl];

    if (await isGifUrl(imageUrl)) {
      const result = await extractGifFrames(imageUrl);
      if (result && result.frames.length > 0) {
        imageUrls = result.frames;
      } else {
        logger.warn(
          `[multimodal] Failed to extract GIF frames, using original URL`,
        );
      }
    }

    imageUrls = await prepareImageUrlsForModel(imageUrls);

    // 构建提示词
    const systemPrompt = `You are an image analysis assistant. Your task is to provide a detailed, accurate description of the image.

Instructions:
- Describe what you see in the image clearly and objectively
- Include important details like objects, people, text, colors, composition, and atmosphere
- If there is text in the image, transcribe it accurately
- Keep your description concise but comprehensive (2-4 sentences)
- Use natural language that can be easily understood
${imageUrls.length > 1 ? "\n- Note: You are viewing multiple frames from an animated image (GIF). Describe the overall motion and changes across frames." : ""}
${context ? `\nUser context: ${context}` : ""}`;

    const userPrompt = context
      ? `Please describe this image in detail, paying special attention to anything relevant to: "${context}"`
      : imageUrls.length > 1
        ? `Please describe these ${imageUrls.length} frames from an animated image in detail.`
        : "Please describe this image in detail.";

    // 构建消息内容
    const contentParts: ChatCompletionContentPart[] = [
      textPart(userPrompt),
      ...imageUrls.map((url) => imagePart(url, "auto")),
    ];

    // 调用多模态模型
    const response = await ai.complete({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: contentParts,
        },
      ],
      temperature: 0.3, // 使用较低的温度以获得更准确的描述
    });

    if (!response.content) {
      logger.warn("[multimodal] No description returned from model");
      return {
        success: false,
        error: "Model returned empty response",
      };
    }

    logger.info(`[multimodal] image: ${response.content}`);

    return {
      success: true,
      description: response.content,
    };
  } catch (err) {
    logger.error(`[multimodal] Failed to describe image: ${err}`);
    return {
      success: false,
      error: String(err),
    };
  }
}

export type MediaByMessageId =
  | { kind: "image"; url: string }
  | { kind: "video"; sources: string[] }
  | null;

/** 指定消息里的第一个图片或视频 */
export async function getMediaByMessageId(
  ctx: MiokuContext,
  messageId: string,
  event: ChatTurnEvent | undefined,
): Promise<MediaByMessageId> {
  try {
    const bot = event?.bot ?? ctx.pickBot(event?.self_id ?? "");
    if (!bot) return null;
    const msg = await bot.getMessage(messageId);
    if (!msg || !msg.message) return null;

    for (const seg of msg.message) {
      if (seg.type === "image") {
        const url = String(seg.data?.url ?? seg.data?.file ?? "");
        if (url) return { kind: "image", url };
      }
      if (seg.type === "video") {
        const sources = getSegmentSourceCandidates(seg);
        if (sources.length > 0) return { kind: "video", sources };
      }
    }

    return null;
  } catch (err) {
    ctx.logger.error(
      `[multimodal] Failed to get media from message ${messageId}: ${err}`,
    );
    return null;
  }
}
