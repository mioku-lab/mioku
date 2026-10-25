import type { AIInstance, Logger } from "mioku";
import type { ChatConfig, ChatMessage } from "../types";
import { extractJsonObject } from "../utils/json";
import { readField } from "../utils/record";

/** 判断只需要最近的几轮上下文，比正式回复的历史短得多 */
export const REPLY_GATE_HISTORY_COUNT = 20;

const CONTENT_MAX_CHARS = 200;
const REASON_MAX_CHARS = 40;

type GateLogger = Pick<Logger, "debug" | "warn">;

export interface ReplyGateRequest {
  cfg: ChatConfig;
  botNickname: string;
  /** 命中的昵称；只被引用时为空 */
  nickname?: string;
  quotedBot: boolean;
  senderName: string;
  text: string;
  messageId?: string;
  history: ChatMessage[];
}

export interface ReplyGateDecision {
  reply: boolean;
  reason: string;
}

/** 弱信号（引用／昵称命中）该接话还是沉默；判断不了时按需要回复处理 */
export async function decideReplyGate(
  ai: AIInstance | undefined,
  log: GateLogger,
  req: ReplyGateRequest,
): Promise<ReplyGateDecision> {
  if (!ai) {
    log.warn("[ReplyGate] 工作模型不可用，按需要回复处理");
    return { reply: true, reason: "no-ai" };
  }

  let content: string;
  try {
    content = await ai.generateText({
      prompt: buildPrompt(req),
      messages: [],
      model: req.cfg.workingModel || req.cfg.model,
      temperature: 0.2,
      max_tokens: 200,
    });
  } catch (err) {
    log.warn(`[ReplyGate] 判断失败，按需要回复处理: ${err}`);
    return { reply: true, reason: "request-failed" };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(content || "");
  } catch {
    parsed = undefined;
  }

  const reply = readField(parsed, "reply");
  if (typeof reply !== "boolean") {
    log.warn(
      `[ReplyGate] 返回内容无法解析，按需要回复处理: ${String(content || "").slice(0, 80)}`,
    );
    return { reply: true, reason: "parse-failed" };
  }

  const reason = String(readField(parsed, "reason") ?? "")
    .trim()
    .slice(0, REASON_MAX_CHARS);
  log.debug(`[ReplyGate] reply=${reply} reason=${reason}`);
  return { reply, reason };
}

function buildPrompt(req: ReplyGateRequest): string {
  const aliases = (req.cfg.nicknames || [])
    .map((name) => String(name || "").trim())
    .filter((name) => name && name !== req.botNickname);
  const aliasLine =
    aliases.length > 0 ? `，也可能被叫成 ${aliases.join("、")}` : "";
  const triggerLine = req.quotedBot
    ? `这条消息引用了你说过的话${req.nickname ? `，文字里还出现了「${req.nickname}」` : ""}`
    : `这条消息的文字里出现了你的名字「${req.nickname}」`;

  return `你是群聊里的机器人，名字是 ${req.botNickname}${aliasLine}。${triggerLine}，但这不一定是在跟你说话。

最近的群聊记录（从旧到新）：
${formatHistory(req.history, req.messageId)}

要判断的消息：
[${req.senderName}]：${req.text.trim() || "(没有文字内容)"}

判断标准：
- 该回：明确在叫你、问你问题、请你帮忙、跟你打招呼，或者接着你说的话往下说。
- 可以不回：只是聊天时顺带带出了你的名字（比如在聊别的人或东西），或者这句话是冲着别人说的。
- 拿不准的时候，接一句或者不出声都行，怎么自然怎么来。

只输出一个 JSON 对象，不要输出任何别的内容：
{"reply": true, "reason": "一句话理由"}
{"reply": false, "reason": "一句话理由"}`;
}

function formatHistory(
  history: ChatMessage[],
  excludeMessageId?: string,
): string {
  const usable = excludeMessageId
    ? history.filter(
        (msg) => String(msg.messageId ?? "") !== excludeMessageId,
      )
    : history;

  const lines: string[] = [];
  for (const msg of usable.slice(-REPLY_GATE_HISTORY_COUNT)) {
    const content = String(msg.content ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!content) continue;
    lines.push(
      `[${formatClock(msg.timestamp)}] ${msg.userName || "unknown"}: ${content.slice(0, CONTENT_MAX_CHARS)}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(没有可用的聊天记录)";
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}
