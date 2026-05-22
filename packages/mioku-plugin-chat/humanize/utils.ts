import type { ChatConfig } from "../types";

export function pickReplyStyle(config: ChatConfig): string {
  const { replyStyle } = config;
  if (!replyStyle) return "";

  const base = replyStyle.baseStyle || "";
  const styles = replyStyle.multipleStyles || [];
  const prob = replyStyle.multipleProbability ?? 0;

  if (styles.length > 0 && prob > 0 && Math.random() < prob) {
    return styles[Math.floor(Math.random() * styles.length)];
  }
  return base;
}

export function pickPersonalityState(config: ChatConfig): string | null {
  const { personality } = config;
  if (!personality) return null;

  const states = personality.states || [];
  const prob = personality.stateProbability ?? 0;

  if (states.length > 0 && prob > 0 && Math.random() < prob) {
    return states[Math.floor(Math.random() * states.length)];
  }
  return null;
}
