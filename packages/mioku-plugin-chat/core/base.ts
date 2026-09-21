import type { Bot, MiokuContext } from "mioku";
import { createGroupRef, logger } from "mioku";
import type { SkillPermissionRole } from "mioku";
import type { AIInstance, AIService } from "mioku";
import type { ScreenshotService } from "mioku";
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
import { getService, Services } from "mioku";
import { synthesizeAudioSource } from "./media/audio";
import type { AudioServiceApi } from "mioku-service-audio";
import {
  extractStandaloneMarkdownBlock,
  splitOutgoingUnits,
  summarizeMarkdown,
  MARKDOWN_OPEN_TAG,
} from "./media/markdown-message";

export interface SendAIResponseOptions {
  ctx: MiokuContext;
  groupId: number;
  messages: string[];
  config: ChatConfig;
  sentIndices?: Set<number>;
  onLineSent?: () => void | Promise<void>;
  audioService?: AudioServiceApi;
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
): Promise<Array<string | undefined>> {
  const {
    ctx,
    groupId,
    messages,
    config,
    sentIndices,
    onLineSent,
    audioService,
  } = options;
  const typingDelayEnabled = config.enableTypingDelay ?? false;
  const enableMarkdownScreenshot = config.enableMarkdownScreenshot ?? true;
  const bot = ctx.pickBot(selfId);
  if (!bot) {
    ctx.logger.error(
      `[sendAIResponse] bot ${String(selfId)} not found, skip sending group message`,
    );
    return [];
  }

  if (messages.length === 0) return [];

  const sentMessageIds: Array<string | undefined> = new Array(messages.length);
  const recordSentId = (messageIndex: number, messageId?: string) => {
    if (!messageId) return;
    if (messageIndex >= 0 && messageIndex < messages.length) {
      sentMessageIds[messageIndex] ??= messageId;
    }
  };

  for (let i = 0; i < messages.length; i++) {
    if (sentIndices?.has(i)) continue;

    const expandedLines = expandOutgoingLines(messages[i]);

    let pendingReply: string | undefined;
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
          await bot.pokeMember(String(groupId), String(pokeId));
        }
      }

      const lineSegments: any[] = [];

      const finalQuoteId = pendingReply;
      if (finalQuoteId !== undefined) {
        lineSegments.push(ctx.segment.reply(finalQuoteId));
        pendingReply = undefined;
      }

      for (const atId of atUsers) {
        if (String(atId) === String(selfId)) continue;
        lineSegments.push(ctx.segment.at(String(atId)));
      }

      if (markdownContent) {
        const screenshotService = getService(ctx, Services.Screenshot);
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
                segments.push(ctx.segment.reply(finalQuoteIdForImage));
              }
              for (const atId of atUsers) {
                if (String(atId) === String(selfId)) continue;
                segments.push(ctx.segment.at(String(atId)));
              }
              segments.push(
                ctx.segment.image(
                  normalizeImageSource(imageSource || imagePath),
                ),
              );
              return segments;
            },
            imagePath,
          ).then((sentId) => recordSentId(i, sentId));
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
        audioService,
      });
      const fallbackText = !audioSource && audioText ? audioText : undefined;
      if (sendableText) {
        lineSegments.push(ctx.segment.text(sendableText));
      } else if (fallbackText) {
        lineSegments.push(ctx.segment.text(fallbackText));
      }
      if (audioSource) {
        lineSegments.push(ctx.segment.raw("record", { file: audioSource }));
      }

      if (lineSegments.length > 0) {
        const sent = await bot.sendMessage(
          { type: "group", group_id: groupId },
          lineSegments,
        );
        recordSentId(i, sent?.message_id);
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

  return sentMessageIds;
}

export async function sendMessage(
  ctx: MiokuContext,
  groupId: number | undefined,
  userId: number,
  text: string,
  config: ChatConfig,
  selfId: number,
  audioService?: AudioServiceApi,
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

    let pendingReply: string | undefined;
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

      if (groupId && pokeUsers.length > 0) {
        for (const pokeId of pokeUsers) {
          await bot.pokeMember(String(groupId), String(pokeId));
        }
      }

      const hasAt = atUsers.length > 0;

      if (markdownContent) {
        const screenshotService = getService(ctx, Services.Screenshot);
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
                segments.push(ctx.segment.reply(finalQuoteIdForImage));
              }
              for (const atId of atUsers) {
                if (String(atId) !== String(selfId)) {
                  segments.push(ctx.segment.at(String(atId)));
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
        audioService,
      });
      const fallbackText = !audioSource && audioText ? audioText : undefined;

      if (hasAt) {
        const sendableText = markdownContent ?? cleanText;
        const segments: any[] = [];
        if (pendingReply !== undefined) {
          segments.push(ctx.segment.reply(pendingReply));
          pendingReply = undefined;
        }
        if (markdownContent) {
          for (const atId of atUsers) {
            if (String(atId) !== String(selfId)) {
              segments.push(ctx.segment.at(String(atId)));
            }
          }
          if (sendableText) {
            segments.push(ctx.segment.text(sendableText));
          } else if (fallbackText) {
            segments.push(ctx.segment.text(fallbackText));
          }
          if (audioSource) {
            segments.push(ctx.segment.raw("record", { file: audioSource }));
          }

          if (segments.length > 0 && groupId) {
            await bot.sendMessage(
              { type: "group", group_id: groupId },
              segments,
            );
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
        const atPattern = /\[at: ?(\d+)\]/g;

        let lastIndex = 0;
        let match;

        while ((match = atPattern.exec(remaining)) !== null) {
          const beforeAt = remaining.slice(lastIndex, match.index);
          if (beforeAt) {
            const cleaned = beforeAt
              .replace(/\[reply:[^\]\n]+\]/g, "")
              .replace(/\[poke:\d+\]/g, "")
              .replace(/\[audio:[^\]]+\]/gi, "")
              .trim();
            if (cleaned) {
              segments.push(ctx.segment.text(cleaned));
            }
          }

          const atId = match[1];
          if (String(atId) !== String(selfId)) {
            segments.push(ctx.segment.at(String(atId)));
          }

          lastIndex = match.index + match[0].length;
        }

        // 添加 @ 之后的文本
        const afterAt = remaining.slice(lastIndex);
        if (afterAt) {
          const cleaned = afterAt
            .replace(/\[reply:[^\]\n]+\]/g, "")
            .replace(/\[poke:\d+\]/g, "")
            .replace(/\[audio:[^\]]+\]/gi, "")
            .trim();
          if (cleaned) {
            segments.push(ctx.segment.text(cleaned));
          }
        }

        if (audioSource) {
          segments.push(ctx.segment.raw("record", { file: audioSource }));
        } else if (fallbackText) {
          segments.push(ctx.segment.text(fallbackText));
        }

        // 发送消息
        if (segments.length > 0) {
          if (groupId) {
            await bot.sendMessage(
              { type: "group", group_id: groupId },
              segments,
            );
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
            sendSegments.push(ctx.segment.reply(pendingReply));
            pendingReply = undefined;
          }
          if (sendableText) {
            sendSegments.push(ctx.segment.text(sendableText));
          } else if (fallbackText) {
            sendSegments.push(ctx.segment.text(fallbackText));
          }
          if (audioSource) {
            sendSegments.push(ctx.segment.raw("record", { file: audioSource }));
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
    /\\\s*(?=(?:\[\]|\[emotion:[^\]]+\]|\[audio:[^\]]+\]|\[reply:[^\]\n]+\]))/gi,
    "\n",
  );
}

async function buildMarkdownImage(
  ctx: MiokuContext,
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
): Promise<string | undefined> {
  try {
    const sent = await sendByTarget(bot, groupId, userId, buildSegments());
    return sent?.message_id;
  } catch (error) {
    if (!fallbackImagePath || !isLocalFilePath(fallbackImagePath)) {
      throw error;
    }

    const fsPromises = await import("fs/promises");
    const buffer = await fsPromises.readFile(fallbackImagePath);
    const base64Image = `base64://${buffer.toString("base64")}`;
    const sent = await sendByTarget(
      bot,
      groupId,
      userId,
      buildSegments(base64Image),
    );
    return sent?.message_id;
  }
}

async function sendByTarget(
  bot: Bot,
  groupId: number | undefined,
  userId: number | undefined,
  segments: readonly any[],
): Promise<import("mioku").SentMessage | undefined> {
  if (groupId) {
    return await bot.sendMessage(
      { type: "group", group_id: groupId },
      segments,
    );
  }

  if (userId) {
    return await bot.sendMessage(
      { type: "private", user_id: userId },
      segments,
    );
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
  ctx: MiokuContext,
  options: {
    audioText?: string;
    config: ChatConfig;
    audioService?: AudioServiceApi;
  },
): Promise<string | null> {
  const trimmed = String(options.audioText || "").trim();
  if (!trimmed) {
    return null;
  }

  if (!options.config.audio?.enabled) {
    return null;
  }

  if (!options.audioService) {
    return null;
  }

  try {
    return await synthesizeAudioSource(options.audioService, trimmed);
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
  ctx: MiokuContext,
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
    role: msg.role || ("user" as const),
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
  ctx: MiokuContext,
  groupId: number,
  selfId: number,
  fallbackGroupName?: string,
): Promise<GroupInfoResult> {
  let groupName: string | undefined;
  let memberCount: number | undefined;

  try {
    const bot = ctx.pickBot(selfId);
    if (!bot) {
      groupName = fallbackGroupName;
      return { groupName, memberCount };
    }
    const groupInfo = await createGroupRef(bot, String(groupId)).getInfo();
    if (groupInfo) {
      groupName = groupInfo.group_name || fallbackGroupName;
      memberCount = groupInfo.member_count;
    }
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
  logger.info(
    `[getHumanizeContexts] session=${groupSessionId} user=${userName} triggerUserId=${triggerUserId} memoryContext=undefined topicContext="${topicContext?.slice(0, 100) ?? ""}" expressionContext="${expressionContext?.slice(0, 100) ?? ""}"`,
  );
  return result;
}

export interface BuildToolContextOptions {
  ctx: MiokuContext;
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
  audioService?: AudioServiceApi;
}

function resolveTriggerSkillRole(
  ctx: MiokuContext,
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
    audioService,
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
        audioService,
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
  ctx: MiokuContext,
  bot: Bot | undefined,
  sentMessageIds?: Array<string | undefined>,
): void {
  const botNickname = config.nicknames[0] || (bot?.nickname ?? "Miku");
  const selfId = bot ? Number(bot.bot_id) : 0;

  if (!bot) {
    ctx.logger.warn(`[saveBotMessages] bot ${selfId} not available`);
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const botMsg: ChatMessage = {
      sessionId: groupSessionId,
      role: "assistant",
      content: msg ?? "",
      userId: selfId ?? 0,
      userName: botNickname ?? "Miku",
      userRole: "member",
      groupId,
      timestamp,
      messageId: sentMessageIds?.[i],
    };
    db.saveMessage(botMsg);
  }
}

export async function sendEmoji(
  ctx: MiokuContext,
  groupId: number,
  emojiPath: string | null | undefined,
  bot: Bot | undefined,
): Promise<void> {
  if (!emojiPath) return;
  if (!bot) {
    ctx.logger.error(`[sendEmoji] bot not available, skip sending emoji`);
    return;
  }

  try {
    const emojiSegment = ctx.segment.image(`file://${emojiPath}`);
    await bot.sendMessage({ type: "group", group_id: groupId }, [emojiSegment]);
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
      await bot.sendMessage({ type: "group", group_id: groupId }, [
        base64Segment,
      ]);
      ctx.logger.info(`[Emoji] Sent via base64: ${path.basename(emojiPath)}`);
    } catch (base64Err) {
      ctx.logger.error(`[Emoji] Base64 also failed: ${base64Err}`);
    }
  }
}
