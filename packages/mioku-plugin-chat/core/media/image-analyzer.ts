import type { AIInstance } from "mioku";
import type { ChatDatabase } from "../../db";
import type { ImageRecord } from "../../types";
import { logger } from "mioki";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync, mkdirSync, createWriteStream, unlink } from "fs";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

/**
 * 图片分析结果
 */
export interface ImageAnalysisResult {
  success: boolean;
  type?: "meme" | "image";
  description?: string;
  emotion?: string;
  characters?: string[]; // 支持多个角色
  character?: string; // 兼容旧版本
  gifBuffer?: Buffer; // GIF 原始 buffer
  error?: string;
}

export interface ImageAnalysisOptions {
  runAIRequest?<T>(request: () => Promise<T>): Promise<T | null>;
}

function formatImageRecognitionLog(record: {
  type: "meme" | "image";
  description: string;
  emotion?: string | null;
  character?: string | null;
  characters?: string[];
}): string {
  const characters =
    record.characters && record.characters.length > 0
      ? record.characters
      : record.character
        ? [record.character]
        : [];
  return `[image-analyzer] ${record.type}: ${record.description}${record.emotion ? ` [${record.emotion}]` : ""}${characters.length > 0 ? ` (${characters.join(", ")})` : ""}`;
}

/**
 * 已知角色列表（用于提示词）
 */
const KNOWN_CHARACTERS = [
  "hatsune_miku",
  "kagamine_rin",
  "kagamine_len",
  "megurine_luka",
  "kaito",
  "meiko",
  "unknown", // 未知角色
];

/**
 * 情感标签列表
 */
const EMOTION_TAGS = [
  "happy",
  "sad",
  "angry",
  "surprised",
  "confused",
  "excited",
  "tired",
  "shy",
  "proud",
  "default", // 默认/不清楚
];

/**
 * 计算图片内容的哈希值
 */
export async function calculateImageHash(url: string): Promise<string> {
  try {
    // 下载图片内容
    const response = await fetch(url);
    if (!response.ok) {
      // 如果下载失败，降级为 URL 哈希
      return crypto.createHash("md5").update(url).digest("hex");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // 基于图片内容计算哈希
    return crypto.createHash("md5").update(buffer).digest("hex");
  } catch (err) {
    logger.warn(
      `[image-analyzer] Failed to calculate content hash, using URL hash: ${err}`,
    );
    // 降级为 URL 哈希
    return crypto.createHash("md5").update(url).digest("hex");
  }
}

/**
 * 下载图片到本地
 */
async function downloadImage(url: string, savePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = path.dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const file = createWriteStream(savePath);
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://q.qq.com/",
      },
    };

    protocol
      .get(url, options, (response) => {
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(true);
        });
      })
      .on("error", (err) => {
        unlink(savePath, () => {});
        logger.error(`[image-analyzer] Failed to download image: ${err}`);
        resolve(false);
      });
  });
}

/**
 * 获取图片扩展名
 */
function getImageExtension(url: string): string {
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    return ext;
  }
  return ".jpg"; // 默认
}

/**
 * 分析图片内容
 */
export async function analyzeImage(
  ai: AIInstance,
  imageUrl: string,
  model: string,
  gifBuffer?: Buffer,
  options?: ImageAnalysisOptions,
): Promise<ImageAnalysisResult> {
  try {
    // 检查是否为 GIF，如果是则提取三帧
    const { isGifUrl, extractGifFrames } = await import("./gif-extractor");
    let imageUrls: string[] = [imageUrl];
    let originalGifBuffer: Buffer | undefined = gifBuffer;

    if (await isGifUrl(imageUrl)) {
      const result = await extractGifFrames(imageUrl);
      if (result && result.frames.length > 0) {
        imageUrls = result.frames;
        originalGifBuffer = result.buffer;
      } else {
        logger.warn(
          `[image-analyzer] Failed to extract GIF frames, using original URL`,
        );
      }
    }

    const systemPrompt = `You are an image classification and analysis assistant. Your task is to analyze images and provide structured information.

Instructions:
1. Classify the image as either "meme" or "image":
   - "meme": Images with anime/cartoon characters, usually expressing emotions or reactions
   - "image": Regular images conveying information

2. Provide a brief description (max 30 words in Chinese):
   - For memes: First identify the character's name, then describe the character's status, actions, and the text near the image.
   - For images: Describe what you see, summarize the text you see (who did what and where).
   ${imageUrls.length > 1 ? "\n   - Note: You are viewing multiple frames from an animated image (GIF). Consider the overall motion and emotion across all frames." : ""}

3. For memes only:
   - Emotion tag: ${EMOTION_TAGS.join(", ")} (choose ONLY ONE that best represents the overall mood)
   - Character names: Can have multiple characters (array format), use English names. Already known: ${KNOWN_CHARACTERS.join(", ")}. You CAN add new ones.

Response format (JSON):
{
  "type": "meme" or "image",
  "description": "brief description in Chinese",
  "emotion": "emotion tag (choose ONLY ONE)",
  "characters": ["character1", "character2", ...] (array of character names, can be empty or have multiple)
}`;

    const userPrompt =
      imageUrls.length > 1
        ? `Please analyze these ${imageUrls.length} frames from an animated image and provide the classification and description.`
        : "Please analyze this image and provide the classification and description.";

    // 构建消息内容
    const contentParts: any[] = [{ type: "text", text: userPrompt }];
    for (const url of imageUrls) {
      contentParts.push({
        type: "image_url",
        image_url: { url, detail: "auto" },
      });
    }

    const request = () =>
      ai.complete({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: contentParts,
          },
        ],
        temperature: 0.3,
      });
    const response = options?.runAIRequest
      ? await options.runAIRequest(request)
      : await request();

    if (!response) {
      return {
        success: false,
        error: "Request skipped due to active rate limit",
      };
    }

    if (!response.content) {
      return {
        success: false,
        error: "Model returned empty response",
      };
    }

    // 解析 JSON 响应
    let result: any;
    try {
      // 尝试提取 JSON（可能包含在 markdown 代码块中）
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = JSON.parse(response.content);
      }
    } catch {
      logger.warn(
        `[image-analyzer] Failed to parse JSON response: ${response.content}`,
      );
      return {
        success: false,
        error: "Failed to parse model response",
      };
    }

    // 验证和规范化结果
    const type = result.type === "meme" ? "meme" : "image";
    const description = String(result.description || "未知");
    const emotion = type === "meme" ? result.emotion || "default" : undefined;

    // 支持多个角色
    let characters: string[] | undefined;
    if (type === "meme") {
      if (Array.isArray(result.characters)) {
        characters = result.characters
          .map((c: string) => c.trim().toLowerCase())
          .filter(Boolean);
      }
      if (characters && characters.length === 0) {
        characters = undefined;
      }
    }

    const character =
      type === "meme"
        ? characters && characters.length > 0
          ? characters[0]
          : "unknown"
        : undefined;

    logger.info(
      formatImageRecognitionLog({
        type,
        description,
        emotion,
        characters,
      }),
    );

    return {
      success: true,
      type,
      description,
      emotion,
      characters,
      character,
      gifBuffer: originalGifBuffer,
    };
  } catch (err) {
    logger.error(`[image-analyzer] Failed to analyze image: ${err}`);
    return {
      success: false,
      error: String(err),
    };
  }
}

/**
 * 处理图片：分析、保存到数据库、下载表情包
 */
export async function processImage(
  ai: AIInstance,
  imageUrl: string,
  model: string,
  db: ChatDatabase,
  options?: ImageAnalysisOptions,
): Promise<ImageRecord | null> {
  try {
    // 计算哈希（基于图片内容）
    const hash = await calculateImageHash(imageUrl);

    // 检查是否已存在
    const existing = db.getImageByHash(hash);
    if (existing) {
      logger.info(formatImageRecognitionLog(existing));
      return existing;
    }
    const analysis = await analyzeImage(ai, imageUrl, model, undefined, options);
    if (!analysis.success || !analysis.type) {
      logger.warn(`[image-analyzer] Analysis failed: ${analysis.error}`);
      return null;
    }

    let filePath: string | undefined;

    // 如果是表情包，下载到本地
    if (analysis.type === "meme" && analysis.emotion && analysis.description) {
      // 确定文件扩展名：GIF 用 .gif，其他用原始扩展名
      const ext = analysis.gifBuffer ? ".gif" : getImageExtension(imageUrl);

      // 文件名使用描述，不限制长度，只替换非法字符
      const safeDesc = analysis.description.replace(
        /[^\u4e00-\u9fa5a-zA-Z0-9]/g,
        "_",
      );
      const fileName = `${safeDesc}${ext}`;

      // 获取角色列表（支持多个角色）
      const characters =
        analysis.characters && analysis.characters.length > 0
          ? analysis.characters
          : [analysis.character || "unknown"];

      // 为每个角色创建文件夹并保存图片
      const savePromises = characters.map(async (character) => {
        const memeDir = path.join(
          process.cwd(),
          "data",
          "chat",
          "meme",
          character,
          analysis.emotion!,
        );
        const targetPath = path.join(memeDir, fileName);

        // 确保目录存在
        if (!existsSync(memeDir)) {
          await fs.mkdir(memeDir, { recursive: true });
        }

        // 如果是 GIF 且有原始 buffer
        if (analysis.gifBuffer) {
          try {
            await fs.writeFile(targetPath, analysis.gifBuffer);
            return targetPath;
          } catch (err) {
            logger.warn(
              `[image-analyzer] Failed to save GIF for ${character}: ${err}`,
            );
            return null;
          }
        } else {
          // 普通图片，下载
          const downloaded = await downloadImage(imageUrl, targetPath);
          if (downloaded) {
            return targetPath;
          } else {
            logger.warn(`[image-analyzer] Download failed for ${character}`);
            return null;
          }
        }
      });

      const savedPaths = await Promise.all(savePromises);
      filePath = savedPaths.find((p) => p !== null) || undefined;
    }

    // 保存到数据库
    const record: ImageRecord = {
      hash,
      url: imageUrl,
      type: analysis.type,
      description: analysis.description || "未知",
      emotion: analysis.emotion,
      character: analysis.character,
      filePath,
      createdAt: Date.now(),
    };

    db.saveImage(record);

    return record;
  } catch (err) {
    logger.error(`[image-analyzer] Failed to process image: ${err}`);
    return null;
  }
}

/**
 * 从图片 URL 获取描述标签
 * 如果图片已在数据库中，返回 [meme:描述] 或 [image:描述]
 * 否则返回 [image]
 */
export async function getImageTag(
  imageUrl: string,
  db: ChatDatabase,
): Promise<string> {
  const hash = await calculateImageHash(imageUrl);
  const record = db.getImageByHash(hash);

  if (record) {
    return `[${record.type}:${record.description}]`;
  }

  return "[image]";
}
