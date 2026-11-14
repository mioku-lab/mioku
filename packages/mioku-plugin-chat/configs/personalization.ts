import builtinThemesJson from "../themes/builtin.json";
import type { ThemesFile } from "../themes/types";
import type {
  EmotionConfig,
  PseudoHumanConfig,
  ReplyStyleConfig,
  TopicConfig,
  EmojiConfig,
  ExpressionConfig,
  RetentionConfig,
} from "../types";

const builtinThemes = builtinThemesJson as ThemesFile;
const MIKU_REPLY = builtinThemes.reply[0];
const MIKU_EMOTION = builtinThemes.emotion[0];

export const PERSONALIZATION_CONFIG: {
  persona: string;
  emotion: EmotionConfig;
  replyStyle: ReplyStyleConfig;
  replyStyleTheme: string;
  emotionTheme: string;
  pseudoHuman: PseudoHumanConfig;
  topic: TopicConfig;
  emoji: EmojiConfig;
  expression: ExpressionConfig;
  retention: RetentionConfig;
} = {
  // 默认人设与说话风格取自内置主题包；留空表示沿用这里的内联值
  persona: MIKU_REPLY.persona,

  pseudoHuman: {
    enabled: false,
  },

  emotion: {
    defaultEmotion: MIKU_EMOTION.defaultEmotion,
    updateIntervalMs: MIKU_EMOTION.updateIntervalMs,
    emotions: MIKU_EMOTION.emotions,
  },

  replyStyle: {
    baseStyle: MIKU_REPLY.baseStyle,
    multipleStyles: MIKU_REPLY.multipleStyles,
    multipleProbability: MIKU_REPLY.multipleProbability,
  },

  replyStyleTheme: "",
  emotionTheme: "",

  topic: {
    enabled: true,
    windowHours: 5,
    historyWindowCount: 3,
  },

  emoji: {
    enabled: true,
    characters: [],
    stickers: [],
  },

  expression: {
    enabled: true,
    lookbackMessages: 200,
    sampleSize: 30,
  },

  retention: {
    enabled: true,
    messageRetentionMs: 30 * 24 * 60 * 60 * 1000,
    topicRetentionMs: 90 * 24 * 60 * 60 * 1000,
    mediaSummaryRetentionMs: 30 * 24 * 60 * 60 * 1000,
    imageRetentionMs: 60 * 24 * 60 * 60 * 1000,
    eventRetentionMs: 7 * 24 * 60 * 60 * 1000,
    cleanupIntervalMs: 60 * 60 * 1000,
  },
};
