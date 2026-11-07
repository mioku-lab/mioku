import type { MemberProfile, MemoryItem } from "./types";

const KIND_HINT: Record<string, string> = {
  fact: "",
  event: "事件",
  preference: "偏好",
  promise: "约定",
  relation: "关系",
  plan: "计划",
  health: "健康",
  other: "",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

export function formatMemoryLine(item: MemoryItem, includeQuote: boolean): string {
  const who = item.userId ? item.userName || item.userId : "群";
  const kind = KIND_HINT[item.kind] ?? "";
  const prefix = `- ${formatDay(item.updatedAt)} ${who}${kind ? `（${kind}）` : ""}：`;
  const detail = item.detail ? `；${shorten(item.detail, 90)}` : "";
  const quote =
    includeQuote && item.quote ? `（原话「${shorten(item.quote, 60)}」）` : "";
  return `${prefix}${shorten(item.content, 160)}${detail}${quote}`;
}

export function formatProfileLine(profile: MemberProfile): string {
  const traits = profile.traits.slice(0, 3).join("、");
  const habits = profile.habits.slice(0, 2).join("、");
  const topics = profile.topics.slice(0, 3).join("、");
  const relations = profile.relations.slice(0, 2).join("、");
  const parts: string[] = [];
  if (profile.name) parts.push(`称呼「${profile.name}」`);
  if (traits) parts.push(traits);
  if (habits) parts.push(habits);
  if (topics) parts.push(`常聊${topics}`);
  if (relations) parts.push(relations);
  if (profile.note) parts.push(shorten(profile.note, 120));
  if (parts.length === 0) return "";
  return `- ${profile.name || profile.userId}（${profile.userId}）：${parts.join("；")}`;
}

export interface RenderOptions {
  maxChars: number;
  includeQuote: boolean;
  /** 当前说话人的轮廓，优先级最高 */
  speakerProfile?: MemberProfile;
  /** 其他相关成员的轮廓 */
  profiles?: MemberProfile[];
}

/**
 * 渲染注入块。顺序与措辞稳定（同输入产出同一段文本），这样同一轮里
 * 多次组装请求时尾部字节一致，provider 的前缀缓存不容易被自己打散。
 */
export function renderMemoryBlock(
  items: MemoryItem[],
  options: RenderOptions,
): string {
  const { maxChars, includeQuote } = options;
  if (maxChars <= 0) return "";

  const lines: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    if (!line) return true;
    if (used + line.length + 1 > maxChars) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  const speakerLine = options.speakerProfile
    ? formatProfileLine(options.speakerProfile)
    : "";
  if (speakerLine) push(`【当前说话的人】\n${speakerLine}`);

  const others = (options.profiles ?? [])
    .filter((profile) => profile.userId !== options.speakerProfile?.userId)
    .map(formatProfileLine)
    .filter(Boolean);
  if (others.length > 0) push(`【其他人】\n${others.slice(0, 2).join("\n")}`);

  // 每条记忆在循环里逐条扣预算，段落头也一起算；不能再走 push，
  // 否则整段长度会被重复计进 used，命中多条时整段被丢掉（只剩画像）。
  const memoryHeader = "【记忆】\n";
  const memoryLines: string[] = [];
  for (const item of items) {
    const line = formatMemoryLine(item, includeQuote);
    if (used + memoryHeader.length + line.length + 1 > maxChars) break;
    memoryLines.push(line);
    used += line.length + 1;
  }
  if (memoryLines.length > 0) {
    lines.push(`${memoryHeader}${memoryLines.join("\n")}`);
    used += memoryHeader.length;
  }

  if (lines.length === 0) return "";
  return [
    "## 你记得的事（可能过时，只在确实相关时自然地提一句，别硬提）",
    lines.join("\n"),
  ].join("\n");
}
