/**
 * Help image orchestration.
 *
 * `generateHelpImage` is the high-level entry point: it takes a help
 * service, builds the HTML, and asks the screenshot service to render
 * the PNG. The lower-level functions cover:
 *
 * - Image source normalization (`normalizeImageSource`)
 * - Bot profile resolution (`resolveHelpBotProfile`)
 * - Two reply helpers (`replyWithImage`, `sendImageFromSkillContext`)
 *   that handle the local file → base64 fallback when the network
 *   adapter can't send a raw path.
 *
 * Version detection lives in `../utils#getRenderVersions` so the help
 * panel and the status panel share the same logic.
 */

import * as fs from "node:fs/promises";
import type { HelpService, ScreenshotService } from "mioku";
import { checkNightMode } from "../utils";
import { generateHelpHtml } from "./html-generator";

/** POSIX or Windows absolute path → `file://...`; anything else passes through. */
function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Prefix remote / data-URI / absolute paths so the bot framework can route them. */
export function normalizeImageSource(file: string): string {
  const value = String(file || "").trim();
  if (!value) {
    return value;
  }

  if (
    value.startsWith("file://") ||
    value.startsWith("base64://") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }

  if (isLocalFilePath(value)) {
    return `file://${value}`;
  }

  return value;
}

/**
 * Build the help image and write it to disk via the screenshot service.
 * Returns the resulting file path, or `null` if any required service is
 * missing.
 */
export async function generateHelpImage(options: {
  helpService?: HelpService;
  screenshotService?: ScreenshotService;
  miokiVersion?: string;
  miokuVersion?: string;
  botNickname?: string;
  botAvatarUrl?: string;
  targetPluginName?: string;
}): Promise<string | null> {
  const {
    helpService,
    screenshotService,
    miokiVersion,
    miokuVersion,
    botNickname,
    botAvatarUrl,
    targetPluginName,
  } = options;
  if (!helpService || !screenshotService) {
    return null;
  }

  const allHelp = helpService.getAllHelp();
  const hasTarget =
    Boolean(targetPluginName) && allHelp.has(String(targetPluginName));

  const htmlContent = generateHelpHtml(
    allHelp,
    checkNightMode(),
    miokiVersion,
    miokuVersion,
    botNickname,
    botAvatarUrl,
    hasTarget ? targetPluginName : undefined,
  );

  return screenshotService.screenshot(htmlContent, {
    width: 760,
    height: 120,
    fullPage: true,
    type: "png",
  });
}

/**
 * Pick a bot's nickname + avatar URL. Used so the help card can greet
 * the user with their bot's identity rather than a generic string.
 */
export function resolveHelpBotProfile(
  ctx: any,
  event?: any,
): { botNickname: string; botAvatarUrl?: string } {
  const fallbackNickname = "Mioku Bot";
  const selfId = event?.self_id;
  const bot =
    (selfId && typeof ctx?.pickBot === "function"
      ? ctx.pickBot(selfId)
      : null) ||
    (ctx?.bots instanceof Map ? Array.from(ctx.bots.values())[0] : null);
  const botId = selfId || bot?.uin || bot?.user_id || bot?.self_id;
  const botNickname = bot?.nickname || bot?.name || fallbackNickname;
  const botAvatarUrl = botId
    ? `https://q1.qlogo.cn/g?b=qq&nk=${botId}&s=640`
    : undefined;

  return { botNickname, botAvatarUrl };
}

/**
 * Reply to a chat event with a local image file. Falls back to base64
 * encoding if the network adapter can't send a raw file path.
 */
export async function replyWithImage(
  event: any,
  segment: { image: (file: string) => any } | undefined,
  imagePath: string,
): Promise<void> {
  if (!event?.reply) {
    throw new Error("当前上下文不支持发送图片回复");
  }

  try {
    if (segment?.image) {
      await event.reply(segment.image(imagePath));
    } else {
      await event.reply([{ type: "image", file: imagePath }]);
    }
  } catch {
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = `base64://${imageBuffer.toString("base64")}`;

    if (segment?.image) {
      await event.reply(segment.image(base64Image));
    } else {
      await event.reply([{ type: "image", file: base64Image }]);
    }
  }
}

/**
 * Send an image from inside an AI skill handler. Picks the right bot via
 * `ctx.pickBot(selfId)`, supports an optional quote-reply, and falls
 * back to base64 when the adapter refuses a raw path.
 */
export async function sendImageFromSkillContext(options: {
  ctx: any;
  event: any;
  imagePath: string;
  quoteReply?: boolean;
}): Promise<void> {
  const { ctx, event, imagePath, quoteReply = false } = options;
  const selfId = event?.self_id != null ? Number(event.self_id) : undefined;
  const bot =
    selfId != null && typeof ctx?.pickBot === "function"
      ? ctx.pickBot(selfId)
      : undefined;

  if (!bot) {
    throw new Error("当前上下文不支持发送图片");
  }

  const buildImageSegment = (file: string) => {
    const normalizedFile = normalizeImageSource(file);
    if (ctx?.segment?.image) {
      return ctx.segment.image(normalizedFile);
    }
    return { type: "image", file: normalizedFile };
  };

  const sendPayload = async (file: string) => {
    const payload: any[] = [];
    if (quoteReply && event?.message_id != null) {
      payload.push({ type: "reply", id: String(event.message_id) });
    }
    payload.push(buildImageSegment(file));

    if (event?.message_type === "group" && event?.group_id != null) {
      await bot.sendGroupMsg(event.group_id, payload);
      return;
    }

    if (event?.user_id != null) {
      await bot.sendPrivateMsg(event.user_id, payload);
      return;
    }

    throw new Error("当前上下文不支持发送图片");
  };

  try {
    await sendPayload(imagePath);
  } catch (error) {
    if (!isLocalFilePath(imagePath)) {
      throw error;
    }

    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = `base64://${imageBuffer.toString("base64")}`;
    await sendPayload(base64Image);
  }
}
