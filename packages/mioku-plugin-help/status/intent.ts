import type { StatusIntent } from "./types";

/**
 * Parse a user message into a `StatusIntent`.
 *
 * Recognized prefixes: `#状态`, `/状态`, `状态`, `菜单 状态` (also the
 * Latin aliases `zt` / `status`). Anything trailing the leading token is
 * ignored — the panel always renders the full sheet.
 *
 * If the input doesn't look like a status command, returns `{ type: "none" }`
 * and the help plugin's normal flow takes over.
 */

function stripStopword(input: string): string {
  return String(input || "")
    .trim()
    .replace(/^[#/\s]+/, "")
    .replace(/[。.!！?？,，:：；;]+$/g, "");
}

function normalize(value: string): string {
  return String(value || "").toLowerCase().trim();
}

export function resolveStatusIntent(text: string): StatusIntent {
  const source = stripStopword(text);
  if (!source) {
    return { type: "none" };
  }

  // Match leading tokens: "菜单 状态", "状态", "#状态", etc.
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { type: "none" };
  }

  const lead = normalize(tokens[0]);
  if (lead !== "状态" && lead !== "zt" && lead !== "status") {
    return { type: "none" };
  }

  return { type: "full" };
}
