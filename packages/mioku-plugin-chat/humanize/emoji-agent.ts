import { existsSync, readdirSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { getPluginDataDir, type AIInstance } from "mioku";
import { logger } from "mioku";
import type { ChatConfig, ChatMessage, TargetMessage } from "../types";
import { extractGroupIdFromSession } from "../utils/group-config";
import { extractJsonObject } from "../utils/json";
import { readField } from "../utils/record";
import type { ChatConfigProvider } from "./index";

export interface EmojiPickResult {
  success: boolean;
  emojiPath?: string;
  emojiDescription?: string;
  cleanedText: string;
  error?: string;
}

export interface EmojiSelectionContext {
  sessionId: string;
  botNickname: string;
  chatHistory: ChatMessage[];
  targetMessage: TargetMessage;
}

interface EmojiCandidate {
  id: string;
  path: string;
  character: string;
  label: string;
  relativePath: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const STICKER_INTENT_LINE = /^\s*\[\]\s*$/;

export class EmojiAgent {
  private readonly memeBaseDir = path.join(getPluginDataDir("chat"), "meme");

  constructor(
    private readonly ai: AIInstance,
    private readonly getConfig: ChatConfigProvider,
  ) {}

  getAvailableCharacters(): string[] {
    if (!existsSync(this.memeBaseDir)) return [];
    return readdirSync(this.memeBaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  hasAvailableEmojis(configuredCharacters: string[] = []): boolean {
    return this.getVisibleCharacters(configuredCharacters).some((character) =>
      this.directoryContainsImage(path.join(this.memeBaseDir, character)),
    );
  }

  hasStickerIntent(text: string): boolean {
    return String(text || "")
      .split(/\r?\n/)
      .some((line) => STICKER_INTENT_LINE.test(line));
  }

  async processStickerResponse(
    aiResponseText: string,
    context: EmojiSelectionContext,
  ): Promise<EmojiPickResult> {
    const cleanedText = this.cleanStickerIntent(aiResponseText);
    if (!this.hasStickerIntent(aiResponseText)) {
      return { success: false, cleanedText, error: "No sticker intent found" };
    }

    const cfg = this.getConfig(extractGroupIdFromSession(context.sessionId));
    if (!cfg.emoji?.enabled) {
      return { success: false, cleanedText, error: "Emoji disabled" };
    }

    const characters = this.getVisibleCharacters(cfg.emoji.characters || []);
    const candidates = this.filterSelectedStickers(
      await this.collectCandidates(characters),
      cfg.emoji.stickers || [],
    );
    if (candidates.length === 0) {
      return { success: false, cleanedText, error: "No stickers available" };
    }

    const selected =
      candidates.length === 1
        ? candidates[0]
        : await this.selectByAI(candidates, context, cleanedText, cfg);
    if (!selected) {
      return { success: false, cleanedText, error: "Sticker selection failed" };
    }

    return {
      success: true,
      emojiPath: selected.path,
      emojiDescription: selected.label,
      cleanedText,
    };
  }

  private getVisibleCharacters(configuredCharacters: string[]): string[] {
    const available = this.getAvailableCharacters();
    if (configuredCharacters.length === 0) return available;

    const configured = new Set(
      configuredCharacters.map((character) => character.trim().toLowerCase()),
    );
    return available.filter((character) =>
      configured.has(character.toLowerCase()),
    );
  }

  private directoryContainsImage(dir: string): boolean {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        return true;
      }
      if (entry.isDirectory() && this.directoryContainsImage(entryPath))
        return true;
    }
    return false;
  }

  private async collectCandidates(
    characters: string[],
  ): Promise<EmojiCandidate[]> {
    const candidates: EmojiCandidate[] = [];
    for (const character of characters) {
      const characterDir = path.join(this.memeBaseDir, character);
      const files = await this.collectImageFiles(characterDir);
      for (const file of files) {
        const relativePath = path.relative(characterDir, file);
        const fileName = path.basename(file, path.extname(file));
        candidates.push({
          id: this.normalizeStickerId(path.join(character, relativePath)),
          path: file,
          character,
          label: fileName.replace(/[_-]+/g, " ").trim(),
          relativePath,
        });
      }
    }
    return candidates.sort((a, b) =>
      `${a.character}/${a.relativePath}`.localeCompare(
        `${b.character}/${b.relativePath}`,
      ),
    );
  }

  private async collectImageFiles(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectImageFiles(entryPath)));
      } else if (
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(entryPath);
      }
    }
    return files;
  }

  private filterSelectedStickers(
    candidates: EmojiCandidate[],
    selectedStickers: string[],
  ): EmojiCandidate[] {
    if (selectedStickers.length === 0) return candidates;
    const selected = new Set(
      selectedStickers.map((sticker) => this.normalizeStickerId(sticker)),
    );
    return candidates.filter((candidate) => selected.has(candidate.id));
  }

  private normalizeStickerId(value: string): string {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^(?:data\/chat\/)?meme\//i, "");
  }

  private async selectByAI(
    candidates: EmojiCandidate[],
    context: EmojiSelectionContext,
    assistantReply: string,
    cfg: ChatConfig,
  ): Promise<EmojiCandidate | null> {
    const persona = String(cfg.persona || "").trim();
    const candidateList = candidates
      .map(
        (candidate, index) =>
          `${index + 1}. [${candidate.character}] ${candidate.label}`,
      )
      .join("\n");
    const history = context.chatHistory
      .slice(-20)
      .map((message) => {
        const speaker =
          message.role === "assistant"
            ? context.botNickname
            : message.userName || String(message.userId || "User");
        return `${speaker}: ${message.content}`;
      })
      .join("\n");

    const systemPrompt = `You are the sticker selection sub-agent for ${context.botNickname}.
${persona ? `Identity and persona of ${context.botNickname}:\n${persona}\n` : ""}
The main chat agent has decided to send one sticker in this turn. Select the single sticker label that best expresses what ${context.botNickname} intends to communicate.

Rules:
- Use only the conversation context, the current draft reply, and the sticker labels below.
- Sticker labels are text descriptions derived from local filenames. You cannot see the images, so do not invent visual details beyond a label.
- The available stickers are already filtered by the configured character list.
- Return exactly one valid 1-based index as JSON.

Available sticker labels:
${candidateList}

Response format:
{"selectedIndex":1,"reason":"brief reason"}`;
    const userPrompt = `Recent conversation:
${history || "(no earlier messages)"}

Current message from ${context.targetMessage.userName}:
${context.targetMessage.content}

Current draft reply from ${context.botNickname}:
${assistantReply || "(sticker only)"}

Choose the most contextually appropriate sticker label for ${context.botNickname} to send now.`;

    try {
      const response = await this.ai.complete({
        model: cfg.workingModel || cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      });
      const result = extractJsonObject(response.content || "");
      const selectedIndex = readField(result, "selectedIndex");
      if (
        typeof selectedIndex !== "number" ||
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 1 ||
        selectedIndex > candidates.length
      ) {
        logger.warn("[emoji-agent] Invalid sticker selection response");
        return null;
      }

      const selected = candidates[selectedIndex - 1];
      logger.info(
        `[emoji-agent] Selected [${selected.character}] ${selected.label}: ${String(readField(result, "reason") || "")}`,
      );
      return selected;
    } catch (err) {
      logger.warn(`[emoji-agent] Sticker selection failed: ${err}`);
      return null;
    }
  }

  private cleanStickerIntent(text: string): string {
    return String(text || "")
      .split(/\r?\n/)
      .filter((line) => !STICKER_INTENT_LINE.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
