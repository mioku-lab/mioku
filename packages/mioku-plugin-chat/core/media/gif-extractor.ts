import { logger } from "mioki";
import sharp from "sharp";

/**
 * GIF 帧提取结果
 */
export interface GifFramesResult {
  frames: string[]; // base64 编码的帧（PNG 格式）
  buffer: Buffer; // 原始 GIF buffer
}

/**
 * 从 GIF 提取三帧（第一帧、中间帧、末尾帧）
 * @param gifUrl GIF 图片 URL
 * @returns 三帧的 base64 编码和原始 buffer
 */
export async function extractGifFrames(
  gifUrl: string,
): Promise<GifFramesResult | null> {
  try {
    // 下载 GIF
    const response = await fetch(gifUrl);
    if (!response.ok) {
      logger.error(
        `[gif-extractor] Failed to fetch GIF: ${response.statusText}`,
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // 获取 GIF 元数据以确定总帧数
    const metadata = await sharp(buffer, { animated: true }).metadata();
    const totalPages = metadata.pages || 1;

    if (totalPages === 1) {
      // 只有一帧，提取第一帧
      const frame = await sharp(buffer, { animated: false, page: 0 })
        .png()
        .toBuffer();
      const base64 = `data:image/png;base64,${frame.toString("base64")}`;
      return { frames: [base64], buffer };
    }

    // 计算要提取的帧索引
    const firstIndex = 0;
    const middleIndex = Math.floor(totalPages / 2);
    const lastIndex = totalPages - 1;

    const frames: string[] = [];

    // 提取第一帧
    const firstFrame = await sharp(buffer, {
      animated: false,
      page: firstIndex,
    })
      .png()
      .toBuffer();
    frames.push(`data:image/png;base64,${firstFrame.toString("base64")}`);

    // 提取中间帧
    if (middleIndex !== firstIndex && middleIndex !== lastIndex) {
      const middleFrame = await sharp(buffer, {
        animated: false,
        page: middleIndex,
      })
        .png()
        .toBuffer();
      frames.push(`data:image/png;base64,${middleFrame.toString("base64")}`);
    }

    // 提取末尾帧
    if (lastIndex !== firstIndex) {
      const lastFrame = await sharp(buffer, {
        animated: false,
        page: lastIndex,
      })
        .png()
        .toBuffer();
      frames.push(`data:image/png;base64,${lastFrame.toString("base64")}`);
    }

    logger.info(
      `[gif-extractor] Extracted ${frames.length} frames from GIF (${totalPages} total)`,
    );
    return { frames, buffer };
  } catch (err) {
    logger.error(`[gif-extractor] Failed to extract frames: ${err}`);
    return null;
  }
}

/**
 * 检查 URL 是否为 GIF
 * 优先检查 URL 后缀，其次检测文件内容
 */
export async function isGifUrl(url: string): Promise<boolean> {
  if (url.toLowerCase().includes(".gif")) {
    return true;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://qq.com/",
      },
    });
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("image/gif")) {
      return true;
    }
  } catch {}

  return false;
}
