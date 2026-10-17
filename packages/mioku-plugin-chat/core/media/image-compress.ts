import sharp from "sharp";
import { logger } from "mioku";

const IMAGE_MAX_BYTES = 1 * 1024 * 1024;
const COMPRESS_MAX_WIDTH = 1280;
const COMPRESS_JPEG_QUALITY = 80;

const INLINE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const QQ_IMAGE_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://qq.com/",
};

const FETCH_HEADERS = QQ_IMAGE_FETCH_HEADERS;

export async function prepareImageUrlForModel(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;

  let buffer: Buffer;
  let mimeType: string;
  try {
    const downloaded = await downloadImage(url);
    buffer = downloaded.buffer;
    mimeType = downloaded.mimeType;
  } catch (err) {
    logger.warn(`[image-compress] download failed, using original: ${err}`);
    return url;
  }

  if (buffer.length <= IMAGE_MAX_BYTES && INLINE_MIME_TYPES.has(mimeType)) {
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  try {
    const compressed = await sharp(buffer)
      .resize({ width: COMPRESS_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: COMPRESS_JPEG_QUALITY })
      .toBuffer();
    logger.info(
      `[image-compress] compressed ${buffer.length} -> ${compressed.length} bytes`,
    );
    return `data:image/jpeg;base64,${compressed.toString("base64")}`;
  } catch (err) {
    logger.warn(`[image-compress] compress failed, inlining original: ${err}`);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }
}

export async function prepareImageUrlsForModel(
  urls: string[],
): Promise<string[]> {
  return Promise.all(urls.map(prepareImageUrlForModel));
}

async function downloadImage(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(
      `download failed: ${response.status} ${response.statusText}`,
    );
  }

  const mimeType = normalizeImageMimeType(
    response.headers.get("content-type") || "",
  );
  if (!mimeType) {
    throw new Error(
      `not an image response: ${response.headers.get("content-type") || "unknown"}`,
    );
  }

  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
}

function normalizeImageMimeType(contentType: string): string | null {
  const mimeType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  return mimeType.startsWith("image/") ? mimeType : null;
}
