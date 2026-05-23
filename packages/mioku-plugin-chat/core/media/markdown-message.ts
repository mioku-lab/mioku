export const MARKDOWN_OPEN_TAG = "<MARKDOWN>";
export const MARKDOWN_CLOSE_TAG = "</MARKDOWN>";

export function splitOutgoingUnits(text: string): string[] {
  const normalized = String(text || "").replace(/\r/g, "");
  const result: string[] = [];
  let buffer = "";
  let insideMarkdown = false;

  for (let index = 0; index < normalized.length; ) {
    if (!insideMarkdown && normalized.startsWith(MARKDOWN_OPEN_TAG, index)) {
      if (buffer.trim()) {
        result.push(buffer.trim());
      }
      buffer = MARKDOWN_OPEN_TAG;
      insideMarkdown = true;
      index += MARKDOWN_OPEN_TAG.length;
      continue;
    }

    if (insideMarkdown && normalized.startsWith(MARKDOWN_CLOSE_TAG, index)) {
      buffer += MARKDOWN_CLOSE_TAG;
      if (buffer.trim()) {
        result.push(buffer.trim());
      }
      buffer = "";
      insideMarkdown = false;
      index += MARKDOWN_CLOSE_TAG.length;
      continue;
    }

    const char = normalized[index];
    if (!insideMarkdown && char === "\n") {
      if (buffer.trim()) {
        result.push(buffer.trim());
      }
      buffer = "";
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  if (buffer.trim()) {
    result.push(buffer.trim());
  }

  return result;
}

export function consumeCompleteStreamUnits(
  buffer: string,
  force: boolean,
): { units: string[]; rest: string } {
  let rest = String(buffer || "").replace(/\r/g, "");
  const units: string[] = [];

  while (true) {
    while (rest.startsWith("\n")) {
      rest = rest.slice(1);
    }

    if (!rest) {
      break;
    }

    const next = takeNextStreamUnit(rest, force);
    if (!next) {
      break;
    }

    units.push(next.unit);
    rest = next.rest;
  }

  return { units, rest };
}

export function extractStandaloneMarkdownBlock(text: string): string | null {
  const trimmed = String(text || "").trim();
  if (
    !trimmed.startsWith(MARKDOWN_OPEN_TAG) ||
    !trimmed.endsWith(MARKDOWN_CLOSE_TAG)
  ) {
    return null;
  }

  const inner = trimmed.slice(
    MARKDOWN_OPEN_TAG.length,
    trimmed.length - MARKDOWN_CLOSE_TAG.length,
  );
  return inner.trim() || null;
}

export function summarizeMarkdown(markdown: string): string {
  const lines = String(markdown || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  if (heading) {
    return heading
      .replace(/^#{1,6}\s+/, "")
      .trim()
      .slice(0, 40);
  }

  const firstLine = lines.find((line) => !line.startsWith("```"));
  if (!firstLine) {
    return "Markdown";
  }

  return (
    firstLine
      .replace(/^[>*\-\d.\s`]+/u, "")
      .slice(0, 40)
      .trim() || "Markdown"
  );
}

function takeNextStreamUnit(
  input: string,
  force: boolean,
): { unit: string; rest: string } | null {
  const text = input;
  const openIndex = text.indexOf(MARKDOWN_OPEN_TAG);
  const newlineIndex = text.indexOf("\n");

  if (openIndex === -1) {
    if (newlineIndex >= 0) {
      return {
        unit: text.slice(0, newlineIndex).trim(),
        rest: text.slice(newlineIndex + 1),
      };
    }

    if (force && text.trim()) {
      return {
        unit: text.trim(),
        rest: "",
      };
    }

    return null;
  }

  if (newlineIndex >= 0 && newlineIndex < openIndex) {
    return {
      unit: text.slice(0, newlineIndex).trim(),
      rest: text.slice(newlineIndex + 1),
    };
  }

  if (openIndex > 0) {
    const prefix = text.slice(0, openIndex).trim();
    return prefix
      ? {
          unit: prefix,
          rest: text.slice(openIndex),
        }
      : {
          unit: "",
          rest: text.slice(openIndex),
        };
  }

  const closeIndex = text.indexOf(MARKDOWN_CLOSE_TAG, MARKDOWN_OPEN_TAG.length);
  if (closeIndex < 0) {
    if (force && text.trim()) {
      return {
        unit: text.trim(),
        rest: "",
      };
    }
    return null;
  }

  const endIndex = closeIndex + MARKDOWN_CLOSE_TAG.length;
  const unit = text.slice(0, endIndex).trim();
  let rest = text.slice(endIndex);
  while (rest.startsWith("\n")) {
    rest = rest.slice(1);
  }

  return { unit, rest };
}
