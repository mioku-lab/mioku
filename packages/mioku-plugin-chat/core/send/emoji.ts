import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Bot, MiokuContext } from "mioku";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsPromises.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 往群里发贴纸，file:// 失败时改用 base64 */
export async function sendGroupEmoji(
  ctx: MiokuContext,
  bot: Bot | undefined,
  groupId: string,
  emojiPath: string | null | undefined,
): Promise<void> {
  if (!emojiPath) return;
  if (!bot) {
    ctx.logger.error(`[sendEmoji] bot not available, skip sending emoji`);
    return;
  }

  const target = { type: "group", group_id: groupId } as const;
  try {
    await bot.sendMessage(target, [ctx.segment.image(`file://${emojiPath}`)]);
  } catch {
    try {
      if (!(await fileExists(emojiPath))) {
        ctx.logger.warn(`[Emoji] File not found: ${emojiPath}`);
        return;
      }
      const buffer = await fsPromises.readFile(emojiPath);
      const ext = path.extname(emojiPath).toLowerCase();
      const mimeType = MIME_BY_EXT[ext] ?? "image/jpeg";
      const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      await bot.sendMessage(target, [ctx.segment.image(dataUrl)]);
      ctx.logger.info(`[Emoji] Sent via base64: ${path.basename(emojiPath)}`);
    } catch (base64Err) {
      ctx.logger.error(`[Emoji] Base64 also failed: ${base64Err}`);
    }
  }
}
