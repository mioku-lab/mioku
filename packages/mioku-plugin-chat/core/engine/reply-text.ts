const FUNCTIONAL_BRACKET_PREFIX =
  /\[(at|reply|poke|audio|emotion):[^\]\n]*\]?/gi;

/** 去掉思考块和模型泄露的工具调用标签，功能标记保留给发送阶段解析 */
export function cleanMarkers(text: string): string {
  let cleaned = stripThinkBlocks(text).trim();

  cleaned = cleaned
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/gi, "")
    .replace(/<｜｜DSML｜｜invoke[^>]*>[\s\S]*?<\/｜｜DSML｜｜invoke>/gi, "")
    .replace(
      /<｜｜DSML｜｜parameter[^>]*>[\s\S]*?<\/｜｜DSML｜｜parameter>/gi,
      "",
    );

  return sanitizeBrackets(cleaned);
}

/** 流式输出的一段，清理到可以直接发送 */
export function cleanStreamSegment(segment: string): string {
  return removeStickerIntentLines(cleanMarkers(segment))
    .replace(/\[emotion:[^\]]+\]/gi, "")
    .replace(/\r/g, "")
    .trim();
}

function sanitizeBrackets(text: string): string {
  if (!text) return text;

  const placeholders: string[] = [];
  const working = text.replace(FUNCTIONAL_BRACKET_PREFIX, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\u0000${idx}\u0000`;
  });

  let result = "";
  let orphanLeftCount = 0;
  let i = 0;

  while (i < working.length) {
    const ch = working[i];

    if (ch === "\u0000") {
      const endIdx = working.indexOf("\u0000", i + 1);
      if (endIdx > i) {
        const idx = parseInt(working.slice(i + 1, endIdx), 10);
        if (!Number.isNaN(idx) && placeholders[idx] !== undefined) {
          result += placeholders[idx];
          i = endIdx + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "[") {
      // 贴纸意图标记
      if (working[i + 1] === "]" && isStandaloneToken(working, i, i + 2)) {
        result += "[]";
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < working.length && working[j] !== "]") {
        j++;
      }
      if (j < working.length) {
        i = j + 1;
      } else {
        orphanLeftCount++;
        i++;
      }
      continue;
    }

    if (ch === "]") {
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  if (orphanLeftCount > 0) {
    result += "]".repeat(orphanLeftCount);
  }

  return result;
}

function isStandaloneToken(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  return (
    !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd).trim()
  );
}

function removeStickerIntentLines(text: string): string {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\]\s*$/.test(line))
    .join("\n");
}

function stripThinkBlocks(text: string): string {
  let source = String(text || "");
  let output = "";

  while (source) {
    const open = findThinkOpenTag(source);
    if (!open) {
      output += source;
      break;
    }

    output += source.slice(0, open.index);
    const afterOpen = source.slice(open.end);
    const close = findThinkCloseTag(afterOpen);
    if (!close) {
      break;
    }

    source = afterOpen.slice(close.end);
  }

  return output.replace(/<\/?(?:think|thinking)\s*>/gi, "");
}

export interface ThinkTagStreamFilter {
  push(delta: string, force: boolean): string;
}

/** 流式增量里剥掉 <think> 块，未闭合的标签前缀先留在缓冲里 */
export function createThinkTagStreamFilter(): ThinkTagStreamFilter {
  let buffer = "";
  let insideThink = false;

  return {
    push(delta: string, force: boolean): string {
      buffer += delta;
      let output = "";

      while (buffer) {
        if (insideThink) {
          const close = findThinkCloseTag(buffer);
          if (!close) {
            buffer = force ? "" : keepTagPrefixSuffix(buffer, "</thinking>");
            break;
          }

          buffer = buffer.slice(close.end);
          insideThink = false;
          continue;
        }

        const open = findThinkOpenTag(buffer);
        if (!open) {
          const keep = force ? "" : keepTagPrefixSuffix(buffer, "<thinking>");
          output += buffer.slice(0, buffer.length - keep.length);
          buffer = keep;
          break;
        }

        output += buffer.slice(0, open.index);
        buffer = buffer.slice(open.end);
        insideThink = true;
      }

      return output.replace(/<\/?(?:think|thinking)\s*>/gi, "");
    },
  };
}

interface TagMatch {
  index: number;
  end: number;
}

function findThinkOpenTag(text: string): TagMatch | null {
  const match = /<(think|thinking)\b[^>]*>/i.exec(text);
  return match
    ? { index: match.index, end: match.index + match[0].length }
    : null;
}

function findThinkCloseTag(text: string): TagMatch | null {
  const match = /<\/(think|thinking)\s*>/i.exec(text);
  return match
    ? { index: match.index, end: match.index + match[0].length }
    : null;
}

function keepTagPrefixSuffix(text: string, tagPrefix: string): string {
  const maxLength = Math.min(text.length, tagPrefix.length - 1);
  const lowerText = text.toLowerCase();
  const lowerPrefix = tagPrefix.toLowerCase();

  for (let length = maxLength; length > 0; length--) {
    const suffix = lowerText.slice(-length);
    if (lowerPrefix.startsWith(suffix)) {
      return text.slice(-length);
    }
  }

  return "";
}
