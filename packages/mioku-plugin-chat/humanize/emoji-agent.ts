import type { AIInstance } from "mioku";
import type { ChatDatabase } from "../db";
import type { ChatConfig, ChatMessage } from "../types";
import { logger } from "mioki";
import * as fs from "fs/promises";
import { existsSync, readdirSync } from "fs";
import * as path from "path";

export interface EmojiPickResult {
  success: boolean;
  emojiPath?: string;
  emojiDescription?: string;
  cleanedText?: string;
  error?: string;
}

const AVAILABLE_EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "surprised",
  "confused",
  "excited",
  "tired",
  "shy",
  "proud",
  "default",
  "funny",
  "cute",
  "love",
  "neutral",
];

export class EmojiAgent {
  private ai: AIInstance;
  private config: ChatConfig;
  private db: ChatDatabase;
  private readonly memeBaseDir: string;

  constructor(ai: AIInstance, config: ChatConfig, db: ChatDatabase) {
    this.ai = ai;
    this.config = config;
    this.db = db;
    this.memeBaseDir = path.join(process.cwd(), "data", "chat", "meme");
  }

  getAvailableCharacters(): string[] {
    if (!existsSync(this.memeBaseDir)) {
      return [];
    }

    const entries = readdirSync(this.memeBaseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  getAvailableEmotions(character: string): string[] {
    const characterDir = path.join(this.memeBaseDir, character);
    if (!existsSync(characterDir)) {
      return [];
    }

    const entries = readdirSync(characterDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  parseAllMemeIntents(text: string): { emotion: string }[] {
    const regex = /\[meme:([^\]]+)]/gi;
    const matches = [...text.matchAll(regex)];
    return matches.map((m) => ({ emotion: m[1].trim().toLowerCase() }));
  }

  async processMemeResponse(
    aiResponseText: string,
    sessionId: string,
  ): Promise<EmojiPickResult> {
    const intents = this.parseAllMemeIntents(aiResponseText);
    if (intents.length === 0) {
      return {
        success: false,
        error: "No meme intent found in response",
      };
    }

    const chatHistory = this.db.getMessages(sessionId, 20);

    // 获取配置中的角色列表
    const configChars = this.config.emoji?.characters || [];

    // 决定使用哪些角色
    let targetCharacters: string[];
    if (configChars.length > 0) {
      targetCharacters = configChars;
      logger.debug(
        `[emoji-agent] Using configured characters: ${configChars.join(", ")}`,
      );
    } else {
      targetCharacters = this.getAvailableCharacters();
      logger.debug(
        `[emoji-agent] Using all available characters: ${targetCharacters.join(", ")}`,
      );
    }

    // 只处理第一个 meme 标记
    const intent = intents[0];
    logger.debug(`[emoji-agent] Processing meme intent: ${intent.emotion}`);

    const emojiResult = await this.pickEmoji(
      targetCharacters,
      intent.emotion,
      chatHistory,
    );

    if (!emojiResult.success || !emojiResult.emojiPath) {
      return {
        success: false,
        error: emojiResult.error || "Failed to pick emoji",
      };
    }

    const cleanedText = this.cleanMemeMarker(aiResponseText);

    return {
      success: true,
      emojiPath: emojiResult.emojiPath,
      emojiDescription: emojiResult.description,
      cleanedText,
    };
  }

  async pickEmoji(
    characters: string[],
    emotion: string,
    chatHistory: ChatMessage[],
  ): Promise<{
    success: boolean;
    emojiPath?: string;
    description?: string;
    error?: string;
  }> {
    try {
      const normalizedEmotion = this.normalizeEmotion(emotion);
      logger.debug(
        `[emoji-agent] pickEmoji: emotion=${normalizedEmotion}, characters=${characters.join(",")}`,
      );

      // 收集所有角色对应情绪目录下的表情包
      const allEmojis: { path: string; character: string; file: string }[] = [];

      for (const character of characters) {
        const emotionDir = path.join(
          this.memeBaseDir,
          character,
          normalizedEmotion,
        );

        logger.debug(
          `[emoji-agent] Checking dir: ${emotionDir}, exists=${existsSync(emotionDir)}`,
        );

        if (existsSync(emotionDir)) {
          const files = (await fs.readdir(emotionDir)).filter((f) => {
            const ext = path.extname(f).toLowerCase();
            return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
          });

          logger.debug(
            `[emoji-agent] Found ${files.length} files in ${character}/${normalizedEmotion}`,
          );

          for (const file of files) {
            allEmojis.push({
              path: path.join(emotionDir, file),
              character,
              file,
            });
          }
        }
      }

      logger.debug(`[emoji-agent] Total emojis collected: ${allEmojis.length}`);

      // 如果没有找到对应情绪的表情包，尝试 default
      if (allEmojis.length === 0) {
        logger.info(
          `[emoji-agent] No emojis found for ${normalizedEmotion}, trying default`,
        );
        for (const character of characters) {
          const defaultDir = path.join(this.memeBaseDir, character, "default");
          if (existsSync(defaultDir)) {
            const files = (await fs.readdir(defaultDir)).filter((f) => {
              const ext = path.extname(f).toLowerCase();
              return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
            });

            for (const file of files) {
              allEmojis.push({
                path: path.join(defaultDir, file),
                character,
                file,
              });
            }
          }
        }
        logger.debug(
          `[emoji-agent] Total emojis from default: ${allEmojis.length}`,
        );
      }

      if (allEmojis.length === 0) {
        return {
          success: false,
          error: `No memes found for emotion: ${emotion}`,
        };
      }

      // 如果只有一个表情包，直接返回
      if (allEmojis.length === 1) {
        const emoji = allEmojis[0];
        return {
          success: true,
          emojiPath: emoji.path,
          description: path.basename(emoji.file, path.extname(emoji.file)),
        };
      }

      // 检查是否使用 AI 选择
      const useAI = this.config.emoji?.useAISelection;
      if (!useAI) {
        // 不使用 AI，直接随机选择
        logger.info(`[emoji-agent] useAISelection=false, random pick`);
        return this.randomPick(allEmojis);
      }

      // 使用 AI 选择最合适的表情包
      return this.selectByAI(allEmojis, normalizedEmotion, chatHistory);
    } catch (err) {
      logger.error(`[emoji-agent] Failed to pick emoji: ${err}`);
      return {
        success: false,
        error: String(err),
      };
    }
  }

  private normalizeEmotion(emotion: string): string {
    const normalized = emotion.toLowerCase();
    if (AVAILABLE_EMOTIONS.includes(normalized)) {
      return normalized;
    }
    const mapping: Record<string, string> = {
      开心: "happy",
      难过: "sad",
      生气: "angry",
      惊讶: "surprised",
      困惑: "confused",
      兴奋: "excited",
      疲倦: "tired",
      害羞: "shy",
      骄傲: "proud",
      默认: "default",
      有趣: "funny",
      可爱: "cute",
      爱: "love",
      中性: "neutral",
    };
    return mapping[normalized] || "default";
  }

  private async selectByAI(
    emojis: { path: string; character: string; file: string }[],
    emotion: string,
    chatHistory: ChatMessage[],
  ): Promise<{
    success: boolean;
    emojiPath?: string;
    description?: string;
    error?: string;
  }> {
    const model = this.config.workingModel || this.config.model;

    const systemPrompt = `You are an emoji/sticker selection assistant. Your task is to select the most appropriate emoji/sticker from a given list based on the chat context.

Instructions:
1. Analyze the chat history provided
2. Select the emoji that best matches the current conversation mood and context
3. Consider the emotional tone of the conversation
4. Provide your selection in JSON format

Available emojis (${emotion}):
${emojis.map((e, i) => `${i + 1}. [${e.character}] ${path.basename(e.file, path.extname(e.file))}`).join("\n")}

Response format (JSON):
{
  "selectedIndex": number (1-based index from the list above),
  "reason": "brief reason why this emoji is suitable"
}`;

    const historyText = chatHistory
      .slice(-10)
      .map((msg) => {
        const role = msg.role === "assistant" ? "Bot" : msg.userName || "User";
        return `${role}: ${msg.content}`;
      })
      .join("\n");

    const userPrompt = `Chat history:
${historyText}

Select the most appropriate emoji for this conversation. The emoji should match the emotional context "${emotion}".`;

    try {
      const response = await this.ai.complete({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      });

      if (!response.content) {
        return this.randomPick(emojis);
      }

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.randomPick(emojis);
      }

      const result = JSON.parse(jsonMatch[0]);
      const selectedIndex = result.selectedIndex;

      if (
        typeof selectedIndex !== "number" ||
        selectedIndex < 1 ||
        selectedIndex > emojis.length
      ) {
        return this.randomPick(emojis);
      }

      const selected = emojis[selectedIndex - 1];
      const description = path.basename(
        selected.file,
        path.extname(selected.file),
      );

      logger.info(
        `[emoji-agent] Selected: [${selected.character}] ${selected.file} (index: ${selectedIndex}, reason: ${result.reason})`,
      );

      return {
        success: true,
        emojiPath: selected.path,
        description,
      };
    } catch (err) {
      logger.warn(`[emoji-agent] AI selection failed, using random: ${err}`);
      return this.randomPick(emojis);
    }
  }

  private randomPick(
    emojis: { path: string; character: string; file: string }[],
  ): {
    success: boolean;
    emojiPath?: string;
    description?: string;
    error?: string;
  } {
    const selected = emojis[Math.floor(Math.random() * emojis.length)];
    const description = path.basename(
      selected.file,
      path.extname(selected.file),
    );

    return {
      success: true,
      emojiPath: selected.path,
      description,
    };
  }

  private cleanMemeMarker(text: string): string {
    let cleaned = text.replace(/\[meme:[^\]]+\]/gi, "");
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    cleaned = cleaned
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
    cleaned = cleaned.trim();
    return cleaned;
  }
}
