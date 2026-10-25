import * as crypto from "crypto";
import type { AIInstance } from "mioku";
import { logger } from "mioku";
import type { ChatDatabase } from "../../db";
import type { ImageRecord } from "../../types";
import {
  IMAGE_FETCH_TIMEOUT_MS,
  prepareImageUrlsForModel,
  QQ_IMAGE_FETCH_HEADERS,
} from "./image-compress";

export interface ImageAnalysisResult {
  success: boolean;
  description?: string;
  error?: string;
}

export interface ImageAnalysisOptions {
  runAIRequest?<T>(request: () => Promise<T>): Promise<T | null>;
}

export async function calculateImageHash(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: QQ_IMAGE_FETCH_HEADERS,
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        `[image-analyzer] Failed to download image for hashing: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.startsWith("text/")) {
      logger.warn(
        `[image-analyzer] Non-image content for hashing (${contentType}): ${url}`,
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return crypto.createHash("md5").update(buffer).digest("hex");
  } catch (err) {
    logger.warn(
      `[image-analyzer] Failed to download image for hashing: ${err}`,
    );
    return null;
  }
}

export async function analyzeImage(
  ai: AIInstance,
  imageUrl: string,
  model: string,
  options?: ImageAnalysisOptions,
): Promise<ImageAnalysisResult> {
  try {
    const { isGifUrl, extractGifFrames } = await import("./gif-extractor");
    let imageUrls = [imageUrl];

    if (await isGifUrl(imageUrl)) {
      const result = await extractGifFrames(imageUrl);
      if (result?.frames.length) {
        imageUrls = result.frames;
      } else {
        logger.warn(
          "[image-analyzer] Failed to extract GIF frames, using original URL",
        );
      }
    }

    imageUrls = await prepareImageUrlsForModel(imageUrls);

    const systemPrompt = `You are an image description assistant. Describe the image accurately for use in chat history.

Instructions:
- Return a concise factual description in Chinese, no more than 30 words.
- Include important visible subjects, actions, expressions, and text.
- Treat every input as a regular image. Do not classify it as a meme or sticker.
${imageUrls.length > 1 ? "- You are viewing frames from an animated image. Describe the overall action across the frames." : ""}

Response format (JSON):
{"description":"brief Chinese description"}`;
    const content: any[] = [
      {
        type: "text",
        text:
          imageUrls.length > 1
            ? `Describe these ${imageUrls.length} frames from one animated image.`
            : "Describe this image.",
      },
      ...imageUrls.map((url) => ({
        type: "image_url",
        image_url: { url, detail: "auto" },
      })),
    ];
    const request = () =>
      ai.complete({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
        temperature: 0.3,
      });
    const response = options?.runAIRequest
      ? await options.runAIRequest(request)
      : await request();

    if (!response?.content) {
      return {
        success: false,
        error: response
          ? "Model returned empty response"
          : "Request skipped due to active rate limit",
      };
    }

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch?.[0] || response.content);
    const description = String(result.description || "未知").trim() || "未知";
    logger.info(`[image-analyzer] image: ${description}`);
    return { success: true, description };
  } catch (err) {
    logger.error(`[image-analyzer] Failed to analyze image: ${err}`);
    return { success: false, error: String(err) };
  }
}

export async function processImage(
  ai: AIInstance,
  imageUrl: string,
  model: string,
  db: ChatDatabase,
  options?: ImageAnalysisOptions,
): Promise<ImageRecord | null> {
  try {
    const hash = await calculateImageHash(imageUrl);
    if (!hash) {
      logger.warn(
        `[image-analyzer] Skipping analysis, image content unavailable: ${imageUrl}`,
      );
      return null;
    }

    const existing = db.getImageByHash(hash);
    if (existing) {
      const normalized = asImageRecord(existing, imageUrl);
      db.saveImage(normalized);
      logger.info(`[image-analyzer] image: ${normalized.description}`);
      return normalized;
    }

    const analysis = await analyzeImage(ai, imageUrl, model, options);
    if (!analysis.success) {
      logger.warn(`[image-analyzer] Analysis failed: ${analysis.error}`);
      return null;
    }

    const record: ImageRecord = {
      hash,
      url: imageUrl,
      type: "image",
      description: analysis.description || "未知",
      createdAt: Date.now(),
    };
    db.saveImage(record);
    return record;
  } catch (err) {
    logger.error(`[image-analyzer] Failed to process image: ${err}`);
    return null;
  }
}

export async function getImageTag(
  imageUrl: string,
  db: ChatDatabase,
): Promise<string> {
  const exact = db.getImageByUrl(imageUrl);
  if (exact) return `[image:${exact.description}]`;

  const hash = await calculateImageHash(imageUrl);
  if (hash) {
    const byHash = db.getImageByHash(hash);
    if (byHash) {
      db.saveImage(asImageRecord(byHash, imageUrl));
      return `[image:${byHash.description}]`;
    }
  }

  return "[image]";
}

function asImageRecord(record: ImageRecord, url: string): ImageRecord {
  return {
    ...record,
    url,
    type: "image",
  };
}

export function normalizeImageUrl(url: string): string {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    const queryIndex = trimmed.indexOf("?");
    const hashIndex = trimmed.indexOf("#");
    const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
    const cutAt = indexes.length > 0 ? Math.min(...indexes) : -1;
    return cutAt >= 0 ? trimmed.slice(0, cutAt) : trimmed;
  }
}
