import type { ChatConfig, EmotionEntryConfig } from "../types";
import { isRecord } from "../utils/record";
import builtinThemes from "./builtin.json";
import {
  BUILTIN_THEME_PREFIX,
  CUSTOM_THEME_PREFIX,
  type EmotionTheme,
  type ReplyStyleTheme,
  type ThemeCatalog,
  type ThemesFile,
} from "./types";

const MAX_THEMES_PER_KIND = 100;
const MAX_NAME_LENGTH = 40;
const MAX_EMOTION_NAME_LENGTH = 20;
const MAX_TEXT_LENGTH = 20_000;
const MAX_STYLES = 40;
const MAX_EXAMPLES = 200;
const MAX_EXAMPLE_LENGTH = 500;
const DEFAULT_MULTIPLE_PROBABILITY = 0.2;
const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60_000;
const MIN_UPDATE_INTERVAL_MS = 60_000;
const MAX_UPDATE_INTERVAL_MS = 30 * 24 * 60 * 60_000;

const BUILTIN = builtinThemes as ThemesFile;

export function normalizeThemeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > 100) return "";
  if (!id.startsWith(BUILTIN_THEME_PREFIX) && !id.startsWith(CUSTOM_THEME_PREFIX)) {
    return "";
  }
  return id;
}

/** 把磁盘上的 chat/themes.json 收窄成可信结构；非法条目直接丢弃 */
export function normalizeThemesFile(raw: unknown): ThemesFile {
  const source = isRecord(raw) ? raw : {};
  return {
    reply: normalizeReplyThemes(source.reply),
    emotion: normalizeEmotionThemes(source.emotion),
  };
}

function normalizeReplyThemes(raw: unknown): ReplyStyleTheme[] {
  if (!Array.isArray(raw)) return [];
  const themes: ReplyStyleTheme[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = normalizeThemeId(item.id);
    if (!id.startsWith(CUSTOM_THEME_PREFIX) || seen.has(id)) continue;
    const name = readText(item.name, MAX_NAME_LENGTH);
    if (!name) continue;
    seen.add(id);
    themes.push({
      id,
      name,
      persona: readText(item.persona, MAX_TEXT_LENGTH),
      baseStyle: readText(item.baseStyle, MAX_TEXT_LENGTH),
      multipleStyles: readTextList(item.multipleStyles, MAX_STYLES, MAX_TEXT_LENGTH),
      multipleProbability: readProbability(item.multipleProbability),
    });
    if (themes.length >= MAX_THEMES_PER_KIND) break;
  }
  return themes;
}

function normalizeEmotionThemes(raw: unknown): EmotionTheme[] {
  if (!Array.isArray(raw)) return [];
  const themes: EmotionTheme[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = normalizeThemeId(item.id);
    if (!id.startsWith(CUSTOM_THEME_PREFIX) || seen.has(id)) continue;
    const name = readText(item.name, MAX_NAME_LENGTH);
    if (!name) continue;
    const emotions = normalizeEmotions(item.emotions);
    seen.add(id);
    themes.push({
      id,
      name,
      emotions,
      defaultEmotion: pickDefaultEmotion(item.defaultEmotion, emotions),
      updateIntervalMs: readInterval(item.updateIntervalMs),
    });
    if (themes.length >= MAX_THEMES_PER_KIND) break;
  }
  return themes;
}

/** 内置主题 + 用户主题。内置主题永远来自代码，同 id 的自定义条目会被忽略 */
export function buildThemeCatalog(raw: unknown): ThemeCatalog {
  const custom = normalizeThemesFile(raw);
  const reply = BUILTIN.reply.map(cloneReplyTheme);
  const emotion = BUILTIN.emotion.map(cloneEmotionTheme);
  const replyIds = new Set(reply.map((theme) => theme.id));
  const emotionIds = new Set(emotion.map((theme) => theme.id));
  for (const theme of custom.reply) {
    if (replyIds.has(theme.id)) continue;
    reply.push(theme);
    replyIds.add(theme.id);
  }
  for (const theme of custom.emotion) {
    if (emotionIds.has(theme.id)) continue;
    emotion.push(theme);
    emotionIds.add(theme.id);
  }
  return { reply, emotion };
}

export function findTheme<T extends { id: string }>(
  themes: T[],
  id: string | undefined,
): T | undefined {
  const normalized = normalizeThemeId(id);
  if (!normalized) return undefined;
  return themes.find((theme) => theme.id === normalized);
}

/**
 * 把选中的主题包展开到 ChatConfig。
 *
 * 选择为空、包不存在时保留 personalization 里的内联配置，作为旧配置与
 * 删除主题后的兜底。
 */
export function applyPersonalizationThemes(
  config: ChatConfig,
  catalog: ThemeCatalog,
): void {
  const replyTheme = findTheme(catalog.reply, config.replyStyleTheme);
  if (replyTheme) {
    config.persona = replyTheme.persona;
    config.replyStyle = {
      baseStyle: replyTheme.baseStyle,
      multipleStyles: [...replyTheme.multipleStyles],
      multipleProbability: replyTheme.multipleProbability,
    };
  }

  const emotionTheme = findTheme(catalog.emotion, config.emotionTheme);
  if (emotionTheme) {
    config.emotion = {
      defaultEmotion: emotionTheme.defaultEmotion,
      updateIntervalMs: emotionTheme.updateIntervalMs,
      emotions: cloneEmotionEntries(emotionTheme.emotions),
    };
  }
}

function cloneReplyTheme(theme: ReplyStyleTheme): ReplyStyleTheme {
  return { ...theme, multipleStyles: [...theme.multipleStyles] };
}

function cloneEmotionTheme(theme: EmotionTheme): EmotionTheme {
  return { ...theme, emotions: cloneEmotionEntries(theme.emotions) };
}

function cloneEmotionEntries(
  emotions: Record<string, EmotionEntryConfig>,
): Record<string, EmotionEntryConfig> {
  const next: Record<string, EmotionEntryConfig> = {};
  for (const [name, entry] of Object.entries(emotions)) {
    next[name] = { examples: [...entry.examples] };
  }
  return next;
}

function normalizeEmotions(
  raw: unknown,
): Record<string, EmotionEntryConfig> {
  const emotions: Record<string, EmotionEntryConfig> = {};
  if (isRecord(raw)) {
    for (const [rawName, value] of Object.entries(raw)) {
      const name = normalizeEmotionName(rawName);
      if (!name || emotions[name]) continue;
      emotions[name] = {
        examples: readTextList(
          isRecord(value) ? value.examples : undefined,
          MAX_EXAMPLES,
          MAX_EXAMPLE_LENGTH,
        ),
      };
    }
  }
  if (!emotions.default) emotions.default = { examples: [] };
  return emotions;
}

function normalizeEmotionName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().slice(0, MAX_EMOTION_NAME_LENGTH);
}

function pickDefaultEmotion(
  raw: unknown,
  emotions: Record<string, EmotionEntryConfig>,
): string {
  const name = normalizeEmotionName(raw);
  if (name && emotions[name]) return name;
  return "default";
}

function readInterval(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_UPDATE_INTERVAL_MS;
  return Math.min(MAX_UPDATE_INTERVAL_MS, Math.max(MIN_UPDATE_INTERVAL_MS, Math.round(num)));
}

function readProbability(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MULTIPLE_PROBABILITY;
  return Math.min(1, Math.max(0, num));
}

function readText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength);
}

function readTextList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text.slice(0, maxLength));
    if (items.length >= maxItems) break;
  }
  return items;
}
