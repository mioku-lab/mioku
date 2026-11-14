import type { EmotionEntryConfig } from "../types";

/** 内置主题包的 id 前缀：内容只来自插件代码，不落配置 */
export const BUILTIN_THEME_PREFIX = "builtin:";
/** 用户主题包的 id 前缀：内容存在 chat/themes.json */
export const CUSTOM_THEME_PREFIX = "custom:";

/**
 * 回复风格主题包
 */
export interface ReplyStyleTheme {
  id: string;
  name: string;
  persona: string;
  baseStyle: string;
  multipleStyles: string[];
  multipleProbability: number;
}

/**
 * 情绪主题包
 */
export interface EmotionTheme {
  id: string;
  name: string;
  defaultEmotion: string;
  updateIntervalMs: number;
  emotions: Record<string, EmotionEntryConfig>;
}

/** 用户自定义主题包文件 chat/themes.json 的结构 */
export interface ThemesFile {
  reply: ReplyStyleTheme[];
  emotion: EmotionTheme[];
}

/** 内置主题 + 用户主题合并后的查询结果 */
export interface ThemeCatalog extends ThemesFile {}
