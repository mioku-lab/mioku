import * as fs from "node:fs/promises";
import type { ScreenshotService } from "mioku";
import { generateMarketHtml } from "./html-generator";
import type { MarketItem } from "../system/package-manager";

function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function normalizeImageSource(file: string): string {
  const value = String(file || "").trim();
  if (!value) return value;
  if (
    value.startsWith("file://") ||
    value.startsWith("base64://") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }
  if (isLocalFilePath(value)) return `file://${value}`;
  return value;
}

function isNightMode(): boolean {
  const hour = new Date().getHours();
  return hour >= 18 || hour < 6;
}

export async function generateMarketImage(options: {
  screenshotService?: ScreenshotService;
  items: MarketItem[];
  kind: "plugin" | "service";
  botAvatarUrl?: string;
  miokuVersion?: string;
}): Promise<string | null> {
  const { screenshotService } = options;
  if (!screenshotService) return null;
  const html = generateMarketHtml({
    items: options.items,
    isNightMode: isNightMode(),
    kind: options.kind,
    botAvatarUrl: options.botAvatarUrl,
    miokuVersion: options.miokuVersion,
  });
  return screenshotService.screenshot(html, {
    width: 760,
    height: 120,
    fullPage: true,
    type: "png",
  });
}

export async function replyWithMarketImage(options: {
  ctx: any;
  event: any;
  imagePath: string;
}): Promise<void> {
  const { ctx, event, imagePath } = options;
  const selfId = event?.self_id != null ? Number(event.self_id) : undefined;
  const bot =
    selfId != null && typeof ctx?.pickBot === "function"
      ? ctx.pickBot(selfId)
      : undefined;
  if (!bot) throw new Error("当前上下文不支持发送图片");

  const buildSegment = (file: string) => {
    const normalized = normalizeImageSource(file);
    if (ctx?.segment?.image) return ctx.segment.image(normalized);
    return { type: "image", file: normalized };
  };

  const send = async (file: string) => {
    if (event?.message_type === "group" && event?.group_id != null) {
      await bot.sendGroupMsg(event.group_id, [buildSegment(file)]);
      return;
    }
    if (event?.user_id != null) {
      await bot.sendPrivateMsg(event.user_id, [buildSegment(file)]);
      return;
    }
    throw new Error("当前上下文不支持发送图片");
  };

  try {
    await send(imagePath);
  } catch (error) {
    if (!isLocalFilePath(imagePath)) throw error;
    const buf = await fs.readFile(imagePath);
    await send(`base64://${buf.toString("base64")}`);
  }
}

export function resolveBotProfile(ctx: any, event?: any): {
  botAvatarUrl?: string;
} {
  const selfId = event?.self_id;
  const bot =
    (selfId && typeof ctx?.pickBot === "function" ? ctx.pickBot(selfId) : null) ||
    (ctx?.bots instanceof Map ? Array.from(ctx.bots.values())[0] : null);
  const botId = selfId || bot?.uin || bot?.user_id || bot?.self_id;
  const botAvatarUrl = botId
    ? `https://q1.qlogo.cn/g?b=qq&nk=${botId}&s=640`
    : undefined;
  return { botAvatarUrl };
}
