import type { MiokiContext } from "mioki";
import { logger } from "mioki";
import type { SkillPermissionRole } from "mioku";
import type { AIInstance, AIService } from "mioku";
import type {
  ChatConfig,
  ChatMessage,
  TargetMessage,
  ToolContext,
} from "../types";
import type { ChatDatabase } from "../db";
import type { HumanizeEngine } from "../humanize";
import { parseLineMarkers, splitByReplyMarkers } from "../utils/queue";
import { getGroupHistory } from "../utils";
import type { ScreenshotService } from "mioku";
import { synthesizeAudioBase64 } from "./media/audio";
import {
  extractStandaloneMarkdownBlock,
  splitOutgoingUnits,
  summarizeMarkdown,
  MARKDOWN_OPEN_TAG,
} from "./media/markdown-message";

export interface SendAIResponseOptions {
  ctx: MiokiContext;
  groupId: number;
  messages: string[];
  config: ChatConfig;
  sentIndices?: Set<number>;
  onLineSent?: () => void | Promise<void>;
}

const FAST_TYPING_BASE_MS = 150;
const FAST_TYPING_PER_CHAR_MS = 65;
const FAST_TYPING_MIN_MS = 150;
const FAST_TYPING_MAX_MS = 2000;
const DEFAULT_TYPING_DELAY_MAX_TOTAL_MS = 10_000;

function calculateTypingDelayMs(text: string): number {
  const chars = Array.from(text.replace(/\s+/g, "")).length;
  const estimated = FAST_TYPING_BASE_MS + chars * FAST_TYPING_PER_CHAR_MS;
  return Math.max(FAST_TYPING_MIN_MS, Math.min(FAST_TYPING_MAX_MS, estimated));
}

function createTypingDelayController(config: ChatConfig) {
  const rawMaxTotalMs = Number(config.typingDelayMaxTotalMs);
  const maxTotalMs =
    Number.isFinite(rawMaxTotalMs) && rawMaxTotalMs >= 0
      ? rawMaxTotalMs
      : DEFAULT_TYPING_DELAY_MAX_TOTAL_MS;

  return {
    spentMs: 0,
    maxTotalMs,
  };
}

async function waitTypingDelay(
  text: string,
  controller: ReturnType<typeof createTypingDelayController>,
): Promise<void> {
  const remainingMs = controller.maxTotalMs - controller.spentMs;
  if (remainingMs <= 0) {
    return;
  }

  const delayMs = Math.min(calculateTypingDelayMs(text), remainingMs);
  if (delayMs <= 0) {
    return;
  }

  controller.spentMs += delayMs;
  await new Promise((r) => setTimeout(r, delayMs));
}

export async function sendAIResponse(
  options: SendAIResponseOptions,
  selfId: number,
): Promise<void> {
  const {
    ctx,
    groupId,
    messages,
    config,
    sentIndices,
    onLineSent,
  } = options;
  const typingDelayEnabled = config.enableTypingDelay ?? false;
  const enableMarkdownScreenshot = config.enableMarkdownScreenshot ?? true;
  const bot = ctx.pickBot(selfId);
  if (!bot) {
    ctx.logger.error(
      `[sendAIResponse] bot ${String(selfId)} not found, skip sending group message`,
    );
    return;
  }

  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i++) {
    if (sentIndices?.has(i)) continue;

    const expandedLines = expandOutgoingLines(messages[i]);

    let pendingReply: number | undefined;
    let lastDelayBasisText = "";

    for (let j = 0; j < expandedLines.length; j++) {
      const line = expandedLines[j];

      const { cleanText, atUsers, pokeUsers, quoteId, audioText } =
        parseLineMarkers(line);

      if (quoteId !== undefined) {
        pendingReply = quoteId;
      }

      const markdownContent = extractStandaloneMarkdownBlock(cleanText);
      const hasContent = cleanText && cleanText.trim().length > 0;
      const hasSendablePayload = Boolean(
        hasContent ||
        markdownContent ||
        atUsers.length > 0 ||
        pokeUsers.length > 0 ||
        audioText,
      );
      const isLastLine = j === expandedLines.length - 1;

      if (!hasSendablePayload && !isLastLine) {
        continue;
      }

      if (!hasSendablePayload) {
        pendingReply = undefined;
        continue;
      }

      if (pokeUsers.length > 0) {
        for (const pokeId of pokeUsers) {
          await bot.api("group_poke", {
            group_id: groupId,
            user_id: pokeId,
          });
        }
      }

      const lineSegments: any[] = [];

      const finalQuoteId = pendingReply;
      if (finalQuoteId !== undefined) {
        lineSegments.push({ type: "reply", id: String(finalQuoteId) });
        pendingReply = undefined;
      }

      for (const atId of atUsers) {
        lineSegments.push(ctx.segment.at(atId));
      }

      if (markdownContent) {
        const screenshotService = ctx.services?.screenshot as
          | ScreenshotService
          | undefined;
        const imagePath = await buildMarkdownImage(
          ctx,
          markdownContent,
          screenshotService,
          enableMarkdownScreenshot,
        );

        if (imagePath) {
          const finalQuoteIdForImage = finalQuoteId;
          await dispatchSegments(
            bot,
            groupId,
            undefined,
            (imageSource?: string) => {
              const segments: any[] = [];
              if (finalQuoteIdForImage !== undefined) {
                segments.push({
                  type: "reply",
                  id: String(finalQuoteIdForImage),
                });
              }
              for (const atId of atUsers) {
                segments.push(ctx.segment.at(atId));
              }
              segments.push(
                ctx.segment.image(
                  normalizeImageSource(imageSource || imagePath),
                ),
              );
              return segments;
            },
            imagePath,
          );
          lastDelayBasisText = summarizeMarkdown(markdownContent);
          if (typingDelayEnabled && j < expandedLines.length - 1) {
            const delayMs = calculateTypingDelayMs(lastDelayBasisText || line);
            await new Promise((r) => setTimeout(r, delayMs));
          }
          continue;
        }
      }

      const sendableText = markdownContent ?? cleanText;
      const audioSource = await resolveAudioSource(ctx, {
        audioText,
        config,
      });
      const fallbackText = !audioSource && audioText ? audioText : undefined;
      if (sendableText) {
        lineSegments.push(ctx.segment.text(sendableText));
      } else if (fallbackText) {
        lineSegments.push(ctx.segment.text(fallbackText));
      }
      if (audioSource) {
        lineSegments.push(ctx.segment.record(audioSource));
      }

      if (lineSegments.length > 0) {
        await bot.sendGroupMsg(groupId, lineSegments);
        lastDelayBasisText = sendableText || fallbackText || audioText || line;
      }

      if (typingDelayEnabled && j < expandedLines.length - 1) {
        const delayMs = calculateTypingDelayMs(lastDelayBasisText || line);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (typingDelayEnabled && i < messages.length - 1) {
      const delayMs = calculateTypingDelayMs(lastDelayBasisText || messages[i]);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    await onLineSent?.();
  }
}

export async function sendMessage(
  ctx: MiokiContext,
  groupId: number | undefined,
  userId: number,
  text: string,
  config: ChatConfig,
  selfId: number,
): Promise<void> {
  const typingDelayEnabled = config.enableTypingDelay ?? false;
  const enableMarkdownScreenshot = config.enableMarkdownScreenshot ?? true;
  try {
    const bot = ctx.pickBot(selfId);
    if (!bot) {
      ctx.logger.error(
        `[sendMessage] bot ${String(selfId)} not found, skip sending`,
      );
      return;
    }

    // 应用错别字生成器
    const expandedLines = expandOutgoingLines(text);

    let pendingReply: number | undefined;
    let lastDelayBasisText = "";

    for (let j = 0; j < expandedLines.length; j++) {
      const line = expandedLines[j];

      const { cleanText, atUsers, pokeUsers, quoteId, audioText } =
        parseLineMarkers(line);

      if (quoteId !== undefined) {
        pendingReply = quoteId;
      }

      const markdownContent = extractStandaloneMarkdownBlock(cleanText);
      const hasContent = cleanText && cleanText.trim().length > 0;
      const hasSendablePayload = Boolean(
        hasContent ||
        markdownContent ||
        atUsers.length > 0 ||
        pokeUsers.length > 0 ||
        audioText,
      );
      const isLastLine = j === expandedLines.length - 1;

      if (!hasSendablePayload && !isLastLine) {
        continue;
      }

      if (!hasSendablePayload) {
        pendingReply = undefined;
        continue;
      }

      // 戳人 - 立即执行
      if (groupId && pokeUsers.length > 0) {
        for (const pokeId of pokeUsers) {
          await bot.api("group_poke", {
            group_id: groupId,
            user_id: pokeId,
          });
        }
      }

      const hasAt = atUsers.length > 0;

      if (markdownContent) {
        const screenshotService = ctx.services?.screenshot as
          | ScreenshotService
          | undefined;
        const imagePath = await buildMarkdownImage(
          ctx,
          markdownContent,
          screenshotService,
          enableMarkdownScreenshot,
        );

        if (imagePath) {
          const finalQuoteIdForImage = pendingReply;
          pendingReply = undefined;
          await dispatchSegments(
            bot,
            groupId,
            userId,
            (imageSource?: string) => {
              const segments: any[] = [];
              if (finalQuoteIdForImage !== undefined) {
                segments.push({
                  type: "reply",
                  id: String(finalQuoteIdForImage),
                });
              }
              for (const atId of atUsers) {
                if (String(atId) !== String(selfId)) {
                  segments.push(ctx.segment.at(atId));
                }
              }
              segments.push(
                ctx.segment.image(
                  normalizeImageSource(imageSource || imagePath),
                ),
              );
              return segments;
            },
            imagePath,
          );
          lastDelayBasisText = summarizeMarkdown(markdownContent);
          if (typingDelayEnabled && j < expandedLines.length - 1) {
            const delayMs = calculateTypingDelayMs(lastDelayBasisText || line);
            await new Promise((r) => setTimeout(r, delayMs));
          }
          continue;
        }
      }

      const audioSource = await resolveAudioSource(ctx, {
        audioText,
        config,
      });
      const fallbackText = !audioSource && audioText ? audioText : undefined;

      if (hasAt) {
        const sendableText = markdownContent ?? cleanText;
        const segments: any[] = [];
        if (pendingReply !== undefined) {
          segments.push({ type: "reply", id: String(pendingReply) });
          pendingReply = undefined;
        }
        if (markdownContent) {
          for (const atId of atUsers) {
            if (String(atId) !== String(selfId)) {
              segments.push(ctx.segment.at(atId));
            }
          }
          if (sendableText) {
            segments.push(ctx.segment.text(sendableText));
          } else if (fallbackText) {
            segments.push(ctx.segment.text(fallbackText));
          }
          if (audioSource) {
            segments.push(ctx.segment.record(audioSource));
          }

          if (segments.length > 0 && groupId) {
            await bot.sendGroupMsg(groupId, segments);
            lastDelayBasisText =
              sendableText || fallbackText || audioText || line;
          }
          if (typingDelayEnabled && j < expandedLines.length - 1) {
            const delayMs = calculateTypingDelayMs(lastDelayBasisText || line);
            await new Promise((r) => setTimeout(r, delayMs));
          }
          continue;
        }
        // 有 @ 用户时，构建消息保持原始位置
        // 先将原始行按 @ 标记分割，然后重新构建
        let remaining = line;
        const atPattern = /\[at:(\d+)\]/g;

        let lastIndex = 0;
        let match;

        while ((match = atPattern.exec(remaining)) !== null) {
          const beforeAt = remaining.slice(lastIndex, match.index);
          if (beforeAt) {
            const cleaned = beforeAt
              .replace(/\[reply:-?\d+\]/g, "")
              .replace(/\[poke:\d+\]/g, "")
              .replace(/\[audio:[^\]]+\]/gi, "")
              .trim();
            if (cleaned) {
              segments.push({ type: "text", text: cleaned });
            }
          }

          const atId = match[1];
          if (String(atId) !== String(selfId)) {
            segments.push(ctx.segment.at(atId));
          }

          lastIndex = match.index + match[0].length;
        }

        // 添加 @ 之后的文本
        const afterAt = remaining.slice(lastIndex);
        if (afterAt) {
          const cleaned = afterAt
            .replace(/\[reply:-?\d+\]/g, "")
            .replace(/\[poke:\d+\]/g, "")
            .replace(/\[audio:[^\]]+\]/gi, "")
            .trim();
          if (cleaned) {
            segments.push({ type: "text", text: cleaned });
          }
        }

        if (audioSource) {
          segments.push(ctx.segment.record(audioSource));
        } else if (fallbackText) {
          segments.push({ type: "text", text: fallbackText });
        }

        // 发送消息
        if (segments.length > 0) {
          if (groupId) {
            await bot.sendGroupMsg(groupId, segments);
            lastDelayBasisText =
              sendableText || fallbackText || audioText || line;
          }
        }
      } else {
        // 没有 @ 用户时，发送普通文本消息
        const sendableText = markdownContent ?? cleanText;
        if (
          sendableText ||
          fallbackText ||
          audioSource ||
          pendingReply !== undefined
        ) {
          const sendSegments: any[] = [];
          if (pendingReply !== undefined) {
            sendSegments.push({ type: "reply", id: String(pendingReply) });
            pendingReply = undefined;
          }
          if (sendableText) {
            sendSegments.push(ctx.segment.text(sendableText));
          } else if (fallbackText) {
            sendSegments.push(ctx.segment.text(fallbackText));
          }
          if (audioSource) {
            sendSegments.push(ctx.segment.record(audioSource));
          }
          if (sendSegments.length > 0) {
            await dispatchSegments(bot, groupId, userId, () => sendSegments);
            lastDelayBasisText =
              sendableText || fallbackText || audioText || line;
          }
        }
      }

      if (typingDelayEnabled && j < expandedLines.length - 1) {
        const delayMs = calculateTypingDelayMs(lastDelayBasisText || line);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } catch (err) {
    ctx.logger.error("[sendMessage] error:", err);
  }
}

function expandOutgoingLines(text: string): string[] {
  const units = splitOutgoingUnits(text);
  const expandedLines: string[] = [];

  for (const unit of units) {
    if (!unit.trim()) {
      continue;
    }

    if (unit.includes(MARKDOWN_OPEN_TAG)) {
      expandedLines.push(unit);
      continue;
    }

    const normalizedUnit = normalizeActionLineBreaks(unit);
    const lineParts = normalizedUnit
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

function normalizeActionLineBreaks(text: string): string {
  return String(text || "").replace(
    /\\\s*(?=(?:\[meme:[^\]]+\]|\[emotion:[^\]]+\]|\[audio:[^\]]+\]|\[reply:-?\d+\]))/gi,
    "\n",
  );
}

async function buildMarkdownImage(
  ctx: MiokiContext,
  markdownContent: string,
  screenshotService: ScreenshotService | undefined,
  enableMarkdownScreenshot: boolean,
): Promise<string | null> {
  if (!enableMarkdownScreenshot || !screenshotService) {
    return null;
  }

  try {
    return await screenshotService.screenshotMarkdown(markdownContent);
  } catch (error) {
    ctx.logger.error(`[MarkdownRender] failed: ${error}`);
    return null;
  }
}

async function dispatchSegments(
  bot: any,
  groupId: number | undefined,
  userId: number | undefined,
  buildSegments: (imageSource?: string) => any[],
  fallbackImagePath?: string,
): Promise<void> {
  try {
    await sendByTarget(bot, groupId, userId, buildSegments());
  } catch (error) {
    if (!fallbackImagePath || !isLocalFilePath(fallbackImagePath)) {
      throw error;
    }

    const fsPromises = await import("fs/promises");
    const buffer = await fsPromises.readFile(fallbackImagePath);
    const base64Image = `base64://${buffer.toString("base64")}`;
    await sendByTarget(bot, groupId, userId, buildSegments(base64Image));
  }
}

async function sendByTarget(
  bot: any,
  groupId: number | undefined,
  userId: number | undefined,
  segments: any[],
): Promise<void> {
  if (groupId) {
    await bot.sendGroupMsg(groupId, segments);
    return;
  }

  if (userId) {
    await bot.sendPrivateMsg(userId, segments);
    return;
  }

  throw new Error("No valid message target");
}

function normalizeImageSource(file: string): string {
  const value = String(file || "").trim();
  if (!value) {
    return value;
  }

  if (
    value.startsWith("file://") ||
    value.startsWith("base64://") ||
    value.startsWith("data:") ||
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

function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

async function resolveAudioSource(
  ctx: MiokiContext,
  options: {
    audioText?: string;
    config: ChatConfig;
  },
): Promise<string | null> {
  const trimmed = String(options.audioText || "").trim();
  if (!trimmed) {
    return null;
  }

  if (!options.config.audio?.enabled || !options.config.audio.baseUrl?.trim()) {
    return null;
  }

  try {
    return await synthesizeAudioBase64(options.config.audio, trimmed);
  } catch (error) {
    ctx.logger.error(
      `[audio] Failed to synthesize voice for "${trimmed}": ${error}`,
    );
    return null;
  }
}

export interface GroupHistoryResult {
  history: ChatMessage[];
  rawHistory: Awaited<ReturnType<typeof getGroupHistory>>;
}

export async function getGroupHistoryMessages(
  groupId: number,
  groupSessionId: string,
  ctx: MiokiContext,
  historyCount: number,
  db: ChatDatabase,
  selfId: number,
  mediaOptions?: {
    ai?: AIInstance;
    workingModel?: string;
    multimodalWorkingModel?: string;
  },
): Promise<GroupHistoryResult> {
  const rawHistory = await getGroupHistory(
    groupId,
    ctx,
    historyCount,
    selfId,
    db,
    mediaOptions,
  );
  const history: ChatMessage[] = rawHistory.map((msg) => ({
    sessionId: groupSessionId,
    role: "user" as const,
    content: msg.content,
    userId: msg.userId,
    userName: msg.userName,
    userRole: msg.userRole,
    groupId,
    timestamp: msg.timestamp,
    messageId: msg.messageId,
  }));

  return { history, rawHistory };
}

export interface GroupInfoResult {
  groupName: string | undefined;
  memberCount: number | undefined;
}

export async function getGroupInfoData(
  ctx: MiokiContext,
  groupId: number,
  selfId: number,
  fallbackGroupName?: string,
): Promise<GroupInfoResult> {
  let groupName: string | undefined;
  let memberCount: number | undefined;

  try {
    const groupInfo = await ctx.pickBot(selfId).getGroupInfo(groupId);
    groupName = (groupInfo as any)?.group_name || fallbackGroupName;
    memberCount = (groupInfo as any)?.member_count;
  } catch {
    groupName = fallbackGroupName;
  }

  return { groupName, memberCount };
}

export interface HumanizeContextsResult {
  memoryContext: string | undefined;
  topicContext: string | undefined;
  expressionContext: string | undefined;
}

export async function getHumanizeContexts(
  humanize: HumanizeEngine,
  groupSessionId: string,
  userName: string,
  history: ChatMessage[],
  triggerUserId?: number,
): Promise<HumanizeContextsResult> {
  const historyStartAt = history.length > 0 ? history[0].timestamp : undefined;

  const topicContext = humanize.topicTracker.getTopicContext(
    groupSessionId,
    historyStartAt,
  );
  const expressionContext = triggerUserId
    ? humanize.expressionLearner.getExpressionContextForUser(
        triggerUserId,
        userName,
      )
    : "";

  const result = {
    memoryContext: undefined,
    topicContext: topicContext || undefined,
    expressionContext: expressionContext || undefined,
  };
  logger.info(`[getHumanizeContexts] session=${groupSessionId} user=${userName} triggerUserId=${triggerUserId} memoryContext=undefined topicContext="${topicContext?.slice(0, 100) ?? ""}" expressionContext="${expressionContext?.slice(0, 100) ?? ""}"`);
  return result;
}

export interface BuildToolContextOptions {
  ctx: MiokiContext;
  event: any;
  selfId: number;
  groupSessionId: string;
  groupId?: number;
  userId: number;
  config: ChatConfig;
  aiService: AIService;
  db: ChatDatabase;
  botRole: "owner" | "admin" | "member";
  pendingImageUrls?: string[];
  humanize: HumanizeEngine;
  targetMessage: TargetMessage;
}

function resolveTriggerSkillRole(
  ctx: MiokiContext,
  event: any,
): SkillPermissionRole {
  const userId = event?.user_id || event?.sender?.user_id;
  if (!userId) {
    return "member";
  }

  try {
    if (ctx.isOwner?.(event)) {
      return "owner";
    }
  } catch {}

  const senderRole = String(event?.sender?.role || "").toLowerCase();
  if (senderRole === "owner" || senderRole === "admin") {
    return "admin";
  }

  try {
    if (ctx.isAdmin?.(event)) {
      return "admin";
    }
  } catch {}

  return "member";
}

export function buildToolContext(
  options: BuildToolContextOptions,
): ToolContext {
  const {
    ctx,
    event,
    selfId,
    groupSessionId,
    groupId,
    userId,
    config,
    aiService,
    db,
    botRole,
    pendingImageUrls,
    humanize,
    targetMessage,
  } = options;

  return {
    ctx,
    event,
    sessionId: groupSessionId,
    groupId,
    userId,
    triggerSkillRole: resolveTriggerSkillRole(ctx, event),
    config,
    aiService,
    db,
    botRole,
    pendingImageUrls,
    onTextContent: async (text) => {
      const content = text.trim();
      if (!content) return;
      await sendMessage(
        ctx,
        groupId,
        targetMessage.userId,
        content,
        config,
        selfId,
      );
    },
  };
}

export function saveBotMessages(
  groupId: number,
  groupSessionId: string,
  messages: string[],
  timestamp: number,
  config: ChatConfig,
  db: ChatDatabase,
  ctx: MiokiContext,
  selfId: number,
): void {
  const bot = ctx.pickBot(selfId);
  const botNickname = config.nicknames[0] || (bot?.nickname ?? "Miku");

  if (!bot) {
    ctx.logger.warn(`[saveBotMessages] bot ${selfId} not available`);
    return;
  }

  for (const msg of messages) {
    const botMsg: ChatMessage = {
      sessionId: groupSessionId,
      role: "assistant",
      content: msg ?? "",
      userId: selfId ?? 0,
      userName: botNickname ?? "Miku",
      userRole: "member",
      groupId,
      timestamp,
    };
    db.saveMessage(botMsg);
  }
}

export async function sendEmoji(
  ctx: MiokiContext,
  groupId: number,
  emojiPath: string | null | undefined,
  selfId: number,
): Promise<void> {
  if (!emojiPath) return;
  const bot = ctx.pickBot(selfId);
  if (!bot) {
    ctx.logger.error(
      `[sendEmoji] bot ${String(selfId)} not found, skip sending emoji`,
    );
    return;
  }

  try {
    const emojiSegment = ctx.segment.image(`file://${emojiPath}`);
    await bot.sendGroupMsg(groupId, [emojiSegment]);
  } catch (err) {
    try {
      const fsPromises = await import("fs/promises");
      const path = await import("path");

      let fileExists: boolean;
      try {
        await fsPromises.access(emojiPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (!fileExists) {
        ctx.logger.warn(`[Emoji] File not found: ${emojiPath}`);
        return;
      }

      const buffer = await fsPromises.readFile(emojiPath);
      const base64 = buffer.toString("base64");
      const ext = path.extname(emojiPath).toLowerCase();
      const mimeType =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".png"
            ? "image/png"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : "image/jpeg";

      const base64DataUrl = `data:${mimeType};base64,${base64}`;
      const base64Segment = ctx.segment.image(base64DataUrl);
      await bot.sendGroupMsg(groupId, [base64Segment]);
      ctx.logger.info(`[Emoji] Sent via base64: ${path.basename(emojiPath)}`);
    } catch (base64Err) {
      ctx.logger.error(`[Emoji] Base64 also failed: ${base64Err}`);
    }
  }
}
