import type { ChatConfig } from "../../types";

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

export interface TypingDelay {
  /** 还有下一条要发时，按刚发出的文字长度停顿一下 */
  pause(basisText: string, hasMore: boolean): Promise<void>;
}

/** 模拟打字停顿，单次回复的总停顿有上限 */
export function createTypingDelay(config: ChatConfig): TypingDelay {
  const enabled = config.enableTypingDelay ?? false;
  const rawMaxTotalMs = Number(config.typingDelayMaxTotalMs);
  const maxTotalMs =
    Number.isFinite(rawMaxTotalMs) && rawMaxTotalMs >= 0
      ? rawMaxTotalMs
      : DEFAULT_TYPING_DELAY_MAX_TOTAL_MS;
  let spentMs = 0;

  return {
    async pause(basisText, hasMore) {
      if (!enabled || !hasMore) return;
      const delayMs = Math.max(
        0,
        Math.min(calculateTypingDelayMs(basisText), maxTotalMs - spentMs),
      );
      spentMs += delayMs;
      await new Promise((r) => setTimeout(r, delayMs));
    },
  };
}
