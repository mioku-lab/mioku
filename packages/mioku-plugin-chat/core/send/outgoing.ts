import { getService, Services } from "mioku";
import type { Bot, MessageSegment, MiokuContext, SentMessage } from "mioku";
import type { AudioServiceApi } from "mioku-service-audio";
import type { ChatConfig } from "../../types";
import { parseLineMarkers, splitByReplyMarkers } from "../../utils/queue";
import { synthesizeAudioSource } from "../media/audio";
import {
  extractStandaloneMarkdownBlock,
  MARKDOWN_OPEN_TAG,
  splitOutgoingUnits,
} from "../media/markdown-message";

/** 发送目标：有 groupId 发群，否则私聊 userId */
export interface SendTarget {
  readonly selfId: string;
  readonly groupId?: string;
  readonly userId?: string;
}

export interface SendOptions {
  config: ChatConfig;
  audioService?: AudioServiceApi;
}

export interface OutgoingLine {
  line: string;
  cleanText: string;
  atUsers: string[];
  pokeUsers: string[];
  quoteId?: string;
  audioText?: string;
  markdownContent: string | null;
  /** 去掉标记后是否还有东西可发 */
  hasPayload: boolean;
}

/** 一条回复按换行和引用标记展开成逐行发送的单元 */
export function expandOutgoingLines(text: string): string[] {
  const expandedLines: string[] = [];

  for (const unit of splitOutgoingUnits(text)) {
    if (!unit.trim()) continue;

    if (unit.includes(MARKDOWN_OPEN_TAG)) {
      expandedLines.push(unit);
      continue;
    }

    const lineParts = normalizeActionLineBreaks(unit)
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const linePart of lineParts) {
      const parts = splitByReplyMarkers(linePart);
      expandedLines.push(...parts.filter((part) => part.trim()));
    }
  }

  return expandedLines;
}

export function parseOutgoingLine(line: string): OutgoingLine {
  const markers = parseLineMarkers(line);
  const markdownContent = extractStandaloneMarkdownBlock(markers.cleanText);
  const hasPayload = Boolean(
    markers.cleanText.trim() ||
    markdownContent ||
    markers.atUsers.length > 0 ||
    markers.pokeUsers.length > 0 ||
    markers.audioText,
  );
  return { line, ...markers, markdownContent, hasPayload };
}

function normalizeActionLineBreaks(text: string): string {
  return String(text || "").replace(
    /\\\s*(?=(?:\[\]|\[emotion:[^\]]+\]|\[audio:[^\]]+\]|\[reply:[^\]\n]+\]))/gi,
    "\n",
  );
}

export async function pokeUsers(
  bot: Bot,
  groupId: string,
  userIds: string[],
): Promise<void> {
  for (const pokeId of userIds) {
    await bot.pokeMember(String(groupId), String(pokeId));
  }
}

export function atSegments(
  ctx: MiokuContext,
  atUsers: string[],
  selfId: string,
): MessageSegment[] {
  return atUsers
    .filter((atId) => String(atId) !== String(selfId))
    .map((atId) => ctx.segment.at(String(atId)));
}

/** Markdown 渲染成截图；未开启或截图失败返回 null */
export async function renderMarkdownImage(
  ctx: MiokuContext,
  markdownContent: string,
  config: ChatConfig,
): Promise<string | null> {
  const enabled = config.enableMarkdownScreenshot ?? true;
  const screenshotService = getService(ctx, Services.Screenshot);
  if (!enabled || !screenshotService) return null;

  try {
    return await screenshotService.screenshotMarkdown(markdownContent);
  } catch (error) {
    ctx.logger.error(`[MarkdownRender] failed: ${error}`);
    return null;
  }
}

/** 发送 Markdown 截图，file:// 发不出去时退回 base64 */
export async function sendMarkdownImage(
  ctx: MiokuContext,
  bot: Bot,
  target: SendTarget,
  imagePath: string,
  prefix: MessageSegment[],
): Promise<string | undefined> {
  const build = (source: string) => [
    ...prefix,
    ctx.segment.image(normalizeImageSource(source)),
  ];
  try {
    const sent = await sendByTarget(bot, target, build(imagePath));
    return sent?.message_id;
  } catch (error) {
    if (!isLocalFilePath(imagePath)) throw error;
    const fsPromises = await import("fs/promises");
    const buffer = await fsPromises.readFile(imagePath);
    const sent = await sendByTarget(
      bot,
      target,
      build(`base64://${buffer.toString("base64")}`),
    );
    return sent?.message_id;
  }
}

export async function sendByTarget(
  bot: Bot,
  target: SendTarget,
  segments: readonly MessageSegment[],
): Promise<SentMessage> {
  if (target.groupId) {
    return bot.sendMessage(
      { type: "group", group_id: target.groupId },
      segments,
    );
  }
  if (target.userId) {
    return bot.sendMessage(
      { type: "private", user_id: target.userId },
      segments,
    );
  }
  throw new Error("No valid message target");
}

function normalizeImageSource(file: string): string {
  const value = String(file || "").trim();
  if (!value) return value;

  if (
    value.startsWith("file://") ||
    value.startsWith("base64://") ||
    value.startsWith("data:") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }

  return isLocalFilePath(value) ? `file://${value}` : value;
}

function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** [audio:...] 标记合成语音；未开启或合成失败返回 null */
export async function resolveAudioSource(
  ctx: MiokuContext,
  audioText: string | undefined,
  opts: SendOptions,
): Promise<string | null> {
  const trimmed = String(audioText || "").trim();
  if (!trimmed || !opts.config.audio?.enabled || !opts.audioService) {
    return null;
  }

  try {
    return await synthesizeAudioSource(opts.audioService, trimmed);
  } catch (error) {
    ctx.logger.error(
      `[audio] Failed to synthesize voice for "${trimmed}": ${error}`,
    );
    return null;
  }
}

export function recordSegment(
  ctx: MiokuContext,
  audioSource: string,
): MessageSegment {
  return ctx.segment.raw("record", { file: audioSource });
}
