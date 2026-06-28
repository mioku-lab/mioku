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
