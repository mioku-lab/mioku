import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { Bot, ForwardNode, logger } from "mioku";
import type { AIInstance } from "mioku";
import type { MediaSummaryKind, MediaSummaryRecord } from "../../types";

const execFileAsync = promisify(execFile);
const VIDEO_FRAME_COUNT = 5;
const VIDEO_FRAME_EXTRACTION_FALLBACK =
  "用户发送了一个视频，但未能提取画面内容";
// 体积阈值：超过此大小（10MB）的视频不再整体上传给多模态工作模型，改用抽帧。
export const VIDEO_FULL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

interface SummaryResult {
  summary: string;
}

export interface MediaMessageSegment {
  type?: string;
  file?: string;
  path?: string;
  url?: string;
  id?: string;
  data?: {
    file?: string;
    path?: string;
    url?: string;
    id?: string;
    data?: string;
    xml?: string;
  };
}

export function getSegmentSourceCandidates(seg: MediaMessageSegment): string[] {
  return Array.from(
    new Set(
      [
        seg?.file,
        seg?.data?.file,
        seg?.path,
        seg?.data?.path,
        seg?.url,
        seg?.data?.url,
      ]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean),
    ),
  );
}

export interface MediaSummaryStore {
  getMediaSummary(key: string): MediaSummaryRecord | null;
  saveMediaSummary(summary: MediaSummaryRecord): void;
  getMediaSummaryBySource?(sourceKey: string): MediaSummaryRecord | null;
  saveMediaSummarySource?(sourceKey: string, summaryKey: string): void;
}

export interface HistoryMediaProcessingOptions {
  ai?: AIInstance;
  workingModel?: string;
  multimodalWorkingModel?: string;
  db?: MediaSummaryStore;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  bot?: Bot;
  groupId?: string;
  runAIRequest?<T>(request: () => Promise<T>): Promise<T | null>;
}

export interface GroupNoticeHistorySummary {
  userId: string;
  userName: string;
  userRole: string;
  content: string;
  timestamp: number;
  messageId: string;
}

function runHistoryMediaAIRequest<T>(
  options: HistoryMediaProcessingOptions,
  request: () => Promise<T>,
): Promise<T | null> {
  return options.runAIRequest ? options.runAIRequest(request) : request();
}

export async function summarizeHistoryVideo(
  videoSource: string | string[],
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const sources = normalizeVideoSources(videoSource);
  if (sources.length === 0 || !options.ai || !options.multimodalWorkingModel) {
    return "[video]";
  }

  const videoFile = await downloadVideoForAnalysis(sources, options);
  try {
    const result = await getOrCreateSummary(
      "video",
      videoFile.source,
      videoFile.contentHash,
      options,
      () => summarizeVideoContent(videoFile.path, videoFile.byteSize, options),
      sources,
    );

    logMediaSummary(options, "video", result.summary);
    return `[video:${result.summary}]`;
  } finally {
    await videoFile.cleanup();
  }
}

export async function summarizeVideoContent(
  videoPath: string,
  byteSize: number,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  // 小视频直接整体喂给多模态工作模型；过大则抽帧避免请求体爆炸。
  if (byteSize <= VIDEO_FULL_UPLOAD_MAX_BYTES) {
    try {
      const summary = await summarizeVideoByFullVideo(videoPath, options);
      if (summary) return summary;
    } catch (err) {
      getHistoryMediaLogger(options).warn(
        `[history-media] Full-video summarization failed, falling back to frames: ${err}`,
      );
    }
  }
  return summarizeVideoByFrames(videoPath, options);
}

async function summarizeVideoByFullVideo(
  videoPath: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const mimeType = await probeVideoMimeType(videoPath);
  const buffer = await fs.readFile(videoPath);
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  const content: any[] = [
    {
      type: "text",
      text: "This is a video sent by someone in a chat. Summarize the video's content in Chinese for later use as chat history context: describe the visible people/objects/actions/scenes/on-screen text, and briefly explain what the video is about. Stay factual and concise; state uncertainty honestly when unclear.",
    },
    {
      type: "video_url",
      video_url: { url: dataUrl },
    },
  ];

  const response = await runHistoryMediaAIRequest(options, () =>
    options.ai!.complete({
      model: options.multimodalWorkingModel,
      messages: [
        {
          role: "system",
          content:
            "You summarize video content for a chat history. Describe only what the video actually shows, objectively and concisely. Do not invent information that is not present.",
        },
        {
          role: "user",
          content,
        },
      ],
      temperature: 0.3,
    }),
  );
  if (!response) return "";
  return normalizeSummary(response.content);
}

async function summarizeVideoByFrames(
  videoPath: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const frames = await extractVideoFrames(
    videoPath,
    VIDEO_FRAME_COUNT,
    options,
  );
  if (frames.length === 0) {
    getHistoryMediaLogger(options).warn(
      "[history-media] Video frame extraction returned 0 frames",
    );
    return VIDEO_FRAME_EXTRACTION_FALLBACK;
  }

  const content: any[] = [
    {
      type: "text",
      text: `These ${frames.length} frames were sampled evenly from a video sent in a chat. Summarize the video's likely content in Chinese for later use as chat history context: note the visible people/objects/actions/on-screen text, and infer what the video is about. Stay factual and concise; if the frames are ambiguous or insufficient, say so honestly.`,
    },
    ...frames.map((frame) => ({
      type: "image_url",
      image_url: { url: frame, detail: "auto" },
    })),
  ];

  const response = await runHistoryMediaAIRequest(options, () =>
    options.ai!.complete({
      model: options.multimodalWorkingModel,
      messages: [
        {
          role: "system",
          content:
            "You summarize video content for a chat history from evenly sampled frames. Describe what the frames plausibly show, objectively and concisely. Do not invent information that is not present.",
        },
        {
          role: "user",
          content,
        },
      ],
      temperature: 0.3,
    }),
  );
  if (!response) return "";
  return normalizeSummary(response.content);
}

export async function getCachedHistoryVideoTag(
  videoSource: string | string[],
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const sources = normalizeVideoSources(videoSource);
  if (sources.length === 0) return "[video]";

  for (const source of sources) {
    const cached = options.db?.getMediaSummaryBySource?.(source);
    if (cached?.summary && !isFallbackVideoSummary(cached.summary)) {
      return `[video:${cached.summary}]`;
    }
  }

  return "[video]";
}

export async function summarizeHistoryForward(
  forwardId: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const id = forwardId.trim();
  if (!id || !options.bot || !options.ai || !options.workingModel) {
    return "[forward]";
  }

  const forwardResult = await options.bot.getForwardMessage(id);
  const text = extractForwardText(forwardResult);
  const source = `forward:${id}`;
  if (!text) {
    const emptyResult = await getOrCreateSummary(
      "forward",
      source,
      hashSource(""),
      options,
      async () => "合并转发消息中没有可读取的文本内容。",
    );
    logMediaSummary(options, "forward", emptyResult.summary);
    return `[forward:${emptyResult.summary}]`;
  }
  const result = await getOrCreateSummary(
    "forward",
    source,
    hashSource(normalizeContentForHash(text)),
    options,
    () =>
      summarizeTextContent(
        "合并转发消息",
        text,
        options.ai!,
        options.workingModel!,
        options,
      ),
  );

  logMediaSummary(options, "forward", result.summary);
  return `[forward:${result.summary}]`;
}

export async function getCachedHistoryForwardTag(
  forwardId: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const id = forwardId.trim();
  if (!id) return "[forward]";
  if (!options.bot) return "[forward]";
  try {
    const forwardResult = await options.bot.getForwardMessage(id);
    const text = extractForwardText(forwardResult);
    const summary = getCachedSummaryByHash(
      "forward",
      hashSource(normalizeContentForHash(text)),
      options,
    );
    return summary ? `[forward:${summary}]` : "[forward]";
  } catch (err) {
    getHistoryMediaLogger(options).warn(
      `[history-media] Failed to resolve cached forward by hash: ${err}`,
    );
    return "[forward]";
  }
}

export async function summarizeHistoryCard(
  cardData: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const source = cardData.trim();
  if (!source || !options.ai || !options.workingModel) {
    return "[card]";
  }

  const normalized = normalizeContentForHash(source);
  const result = await getOrCreateSummary(
    "card",
    source,
    hashSource(normalized),
    options,
    () => {
      const promptContent = extractCardPrompt(source);
      if (promptContent && promptContent.length < 100) {
        return Promise.resolve(promptContent);
      }
      return summarizeTextContent(
        "XML/JSON 卡片消息",
        promptContent || source,
        options.ai!,
        options.workingModel!,
        options,
      );
    },
  );

  logMediaSummary(options, "card", result.summary);
  return `[card:${result.summary}]`;
}

export function getCachedHistoryCardTag(
  cardData: string,
  options: HistoryMediaProcessingOptions,
): string {
  const source = cardData.trim();
  if (!source) return "[card]";
  const summary = getCachedSummaryByHash(
    "card",
    hashSource(normalizeContentForHash(source)),
    options,
  );
  return summary ? `[card:${summary}]` : "[card]";
}

export async function summarizeGroupNotice(
  notice: any,
  options: HistoryMediaProcessingOptions,
): Promise<GroupNoticeHistorySummary | null> {
  if (!options.groupId || !options.ai || !options.workingModel) {
    return null;
  }

  const text = extractNoticeText(notice);
  if (!text) return null;
  const source = `group:${options.groupId}:notice:${text}`;
  const summary = (
    await getOrCreateSummary(
      "notice",
      source,
      hashSource(normalizeContentForHash(text)),
      options,
      () =>
        summarizeTextContent(
          "群公告",
          text,
          options.ai!,
          options.workingModel!,
          options,
        ),
    )
  ).summary;
  const sender = extractNoticeSender(notice);
  const content = `发布了一条群公告：[group_notice:${summary}]`;
  logger.info(
    `[history-media] group_notice: ${sender.userName}(${sender.userId}) ${content}`,
  );
  return {
    userId: sender.userId,
    userName: sender.userName,
    userRole: "member",
    content,
    timestamp: normalizeNoticeTimestamp(notice),
    messageId: String((notice as { message_id?: unknown }).message_id ?? ""),
  };
}

async function getOrCreateSummary(
  kind: MediaSummaryKind,
  source: string,
  contentHash: string,
  options: HistoryMediaProcessingOptions,
  producer: () => Promise<string>,
  sourceAliases: string[] = [],
): Promise<SummaryResult> {
  const cacheKey = `${kind}:${contentHash}`;
  const aliases = Array.from(
    new Set(
      [source, ...sourceAliases]
        .map((s) => String(s || "").trim())
        .filter(Boolean),
    ),
  );
  const cached = options.db?.getMediaSummary(cacheKey);
  if (cached?.summary) {
    if (kind === "video") {
      warnIfFallbackVideoSummary(options, "content hash cache", cached.summary);
      if (isFallbackVideoSummary(cached.summary)) {
        // Old versions cached this probe failure as a valid summary. Ignore it
        // so the new message can be downloaded and diagnosed again.
      } else {
        writeMediaSummarySources(options, cacheKey, aliases);
        return { summary: cached.summary };
      }
    } else {
      writeMediaSummarySources(options, cacheKey, aliases);
      return { summary: cached.summary };
    }
  }

  try {
    const summary = normalizeSummary(await producer());
    if (summary) {
      if (kind === "video" && isFallbackVideoSummary(summary)) {
        return { summary };
      }
      options.db?.saveMediaSummary({
        key: cacheKey,
        kind,
        source,
        summary,
        createdAt: Date.now(),
      });
      writeMediaSummarySources(options, cacheKey, aliases);
      return { summary };
    }
  } catch (err) {
    getHistoryMediaLogger(options).warn(
      `[history-media] Failed to summarize ${kind}: ${err}`,
    );
  }

  return {
    summary: kind === "video" ? "用户发送了一个视频。" : "内容暂时无法解析。",
  };
}

function writeMediaSummarySources(
  options: HistoryMediaProcessingOptions,
  summaryKey: string,
  sources: string[],
): void {
  if (!options.db?.saveMediaSummarySource) return;
  for (const source of sources) {
    options.db.saveMediaSummarySource!(source, summaryKey);
  }
}

function logMediaSummary(
  options: HistoryMediaProcessingOptions,
  kind: MediaSummaryKind,
  summary: string,
): void {
  getHistoryMediaLogger(options).info(`[history-media] ${kind}: ${summary}`);
}

function warnIfFallbackVideoSummary(
  options: HistoryMediaProcessingOptions,
  from: string,
  summary: string,
): void {
  if (!isFallbackVideoSummary(summary)) return;
  getHistoryMediaLogger(options).warn(
    `[history-media] Ignored fallback video summary from ${from}: ${summary}`,
  );
}

function isFallbackVideoSummary(summary: string): boolean {
  return summary === VIDEO_FRAME_EXTRACTION_FALLBACK;
}

function getHistoryMediaLogger(options: HistoryMediaProcessingOptions) {
  return options.logger || logger;
}

async function summarizeTextContent(
  label: string,
  text: string,
  ai: AIInstance,
  model: string,
  options: HistoryMediaProcessingOptions,
): Promise<string> {
  const response = await runHistoryMediaAIRequest(options, () =>
    ai.complete({
      model,
      messages: [
        {
          role: "system",
          content:
            "You summarize non-plain chat content for recent chat history. Output Chinese only, concise and factual. Keep key names, titles, links, amounts, and actions if present.",
        },
        {
          role: "user",
          content: `${label}原始内容：\n${truncateText(text, 8000)}\n\n请概括成一句适合放进聊天历史的中文摘要。`,
        },
      ],
      temperature: 0.3,
    }),
  );
  if (!response) return "";
  return normalizeSummary(response.content);
}

async function extractVideoFrames(
  videoUrl: string,
  frameCount: number,
  options: HistoryMediaProcessingOptions,
): Promise<string[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mioku-video-"));
  try {
    const duration = await probeVideoDuration(videoUrl);
    const timestamps = buildFrameTimestamps(duration, frameCount);
    const frames: string[] = [];

    for (let i = 0; i < timestamps.length; i += 1) {
      const outputPath = path.join(tempDir, `frame-${i}.jpg`);
      await execFileAsync(
        "ffmpeg",
        buildFfmpegInputArgs(videoUrl, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(timestamps[i]),
          "-i",
          videoUrl,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          "-y",
          outputPath,
        ]),
        { timeout: 30_000 },
      );
      const buffer = await fs.readFile(outputPath);
      frames.push(`data:image/jpeg);base64,${buffer.toString("base64")}`);
    }

    return frames;
  } catch (err) {
    getHistoryMediaLogger(options).warn(
      `[history-media] Failed to extract video frames: ${err}`,
    );
    return [];
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function probeVideoDuration(videoUrl: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    buildFfmpegInputArgs(videoUrl, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoUrl,
    ]),
    { timeout: 20_000 },
  );
  const duration = Number(String(stdout).trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
}

export async function probeVideoMimeType(videoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { timeout: 20_000 },
    );
    return mapFormatNameToMimeType(String(stdout).trim());
  } catch {
    return "video/mp4";
  }
}

function mapFormatNameToMimeType(formatName: string): string {
  const names = formatName.split(",").map((s) => s.trim().toLowerCase());
  if (names.some((n) => n === "webm")) return "video/webm";
  if (names.some((n) => n === "matroska" || n === "mkv"))
    return "video/x-matroska";
  if (names.some((n) => n === "avi")) return "video/x-msvideo";
  if (names.some((n) => n === "flv")) return "video/x-flv";
  if (names.some((n) => n === "mov" || n === "mp4" || n === "m4v"))
    return "video/mp4";
  return "video/mp4";
}

function buildFfmpegInputArgs(input: string, args: string[]): string[] {
  if (!/^https?:\/\//i.test(input)) return args;
  const inputIndex = args.findIndex((arg) => arg === input);
  if (inputIndex < 0) return args;
  return [
    ...args.slice(0, inputIndex),
    "-headers",
    "User-Agent: Mozilla/5.0\r\nReferer: https://qq.com/\r\n",
    ...args.slice(inputIndex),
  ];
}

function buildFrameTimestamps(duration: number, frameCount: number): number[] {
  if (frameCount <= 1) return [0];
  const safeDuration = Math.max(duration, 1);
  const maxTimestamp = Math.max(0, safeDuration - 0.2);
  return Array.from({ length: frameCount }, (_, index) => {
    if (frameCount === 1) return 0;
    return Math.min(maxTimestamp, (maxTimestamp * index) / (frameCount - 1));
  });
}

function extractForwardText(result: ForwardNode[]): string {
  const nodes = Array.isArray(result) ? result : [];
  const lines: string[] = [];

  for (const node of nodes) {
    const senderName = node.nickname || String(node.user_id || "unknown");
    const content = extractMessageSegmentsText(node.message);
    if (content) {
      lines.push(`${senderName}: ${content}`);
    }
  }

  return lines.join("\n");
}

function extractMessageSegmentsText(message: any): string {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return "";

  const parts: string[] = [];
  for (const seg of message) {
    const type = seg?.type;
    const data = seg?.data || seg;
    if (type === "text") {
      parts.push(String(data.text || seg.text || "").trim());
    } else if (type === "image") {
      parts.push("[image]");
    } else if (type === "video") {
      parts.push("[video]");
    } else if (type === "forward") {
      parts.push("[forward]");
    } else if (type === "json" || type === "xml" || type === "ark") {
      parts.push(String(data.data || data.xml || seg.data || "").trim());
    }
  }

  return parts.filter(Boolean).join(" ");
}

function extractNoticeText(notice: any): string {
  const values = [
    notice?.message,
    notice?.text,
    notice?.content,
    notice?.title,
    notice?.notice?.message,
    notice?.notice?.content,
    notice?.msg,
    notice?.raw_message,
    extractMessageSegmentsText(notice?.message),
  ];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function extractNoticeSender(notice: any): {
  userId: string;
  userName: string;
} {
  const userId = String(
    notice?.user_id ??
      notice?.sender_id ??
      notice?.operator_id ??
      notice?.poster_id ??
      notice?.publisher_id ??
      notice?.sender?.user_id ??
      "",
  ).trim();
  const userName =
    notice?.sender?.card ||
    notice?.sender?.nickname ||
    notice?.sender_name ||
    notice?.nickname ||
    notice?.publisher_name ||
    notice?.operator_name ||
    (userId ? String(userId) : "unknown");
  return {
    userId,
    userName: String(userName),
  };
}

function normalizeNoticeTimestamp(notice: any): number {
  const raw =
    notice?.publish_time ||
    notice?.time ||
    notice?.created_at ||
    notice?.create_time ||
    Date.now();
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return Date.now();
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeSummary(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export async function downloadVideoForAnalysis(
  sources: string | string[],
  options: HistoryMediaProcessingOptions,
): Promise<{
  path: string;
  source: string;
  contentHash: string;
  byteSize: number;
  cleanup: () => Promise<void>;
}> {
  const candidates = normalizeVideoSources(sources);
  let lastError: unknown;

  for (const source of candidates) {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mioku-video-src-"),
    );
    const filePath = path.join(tempDir, "video");

    try {
      const buffer = await readVideoSource(source);
      await fs.writeFile(filePath, buffer);
      return {
        path: filePath,
        source,
        contentHash: hashSource(buffer),
        byteSize: buffer.length,
        cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
      };
    } catch (err) {
      lastError = err;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      getHistoryMediaLogger(options).warn(
        `[history-media] Failed to read video source ${source}: ${err}`,
      );
    }
  }

  throw lastError || new Error("no video source available");
}

async function readVideoSource(source: string): Promise<Buffer> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://qq.com/",
      },
    });
    if (!response.ok) {
      throw new Error(
        `download failed: ${response.status} ${response.statusText}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  if (source.startsWith("file://")) {
    const url = new URL(source);
    return fs.readFile(
      decodeURIComponent(url.pathname).replace(/^\/([a-z]:[\\/])/i, "$1"),
    );
  }

  return fs.readFile(source);
}

function normalizeVideoSources(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : [input];
  return Array.from(
    new Set(raw.map((source) => String(source || "").trim()).filter(Boolean)),
  );
}

function normalizeContentForHash(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const json = tryParseJson(trimmed);
  if (json.parsed) {
    return stableStringify(json.value);
  }

  return trimmed.replace(/\s+/g, " ");
}

function extractCardPrompt(source: string): string | null {
  const parsed = tryParseJson(source);
  if (!parsed.parsed) return null;
  const prompt = parsed.value?.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}

function tryParseJson(
  value: string,
): { parsed: true; value: any } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(value) };
  } catch {
    return { parsed: false };
  }
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function hashSource(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function getCachedSummaryByHash(
  kind: MediaSummaryKind,
  contentHash: string,
  options: HistoryMediaProcessingOptions,
): string | null {
  const cached = options.db?.getMediaSummary(`${kind}:${contentHash}`);
  if (
    kind === "video" &&
    cached?.summary &&
    isFallbackVideoSummary(cached.summary)
  ) {
    warnIfFallbackVideoSummary(options, "content hash cache", cached.summary);
    return null;
  }
  return cached?.summary || null;
}
