import { HistoryMessage, logger } from "mioku";
import type { AITool } from "mioku";
import type { ChatMessage, ToolContext } from "../../types";
import { searchWebWithSearxng } from "../web/searxng";
import { readWebPage } from "../web/web-reader";
import { MemoryRetrieval } from "../../humanize";
import type { MemoryUserHistoryChunk } from "../../humanize/memory";

const DEFAULT_GROUP_RECALL_LIMIT = 800;
const DEFAULT_USER_HISTORY_LIMIT = 100;

function resolveGroupRecallLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GROUP_RECALL_LIMIT;
  return Math.max(1, Math.floor(parsed));
}

function resolveUserHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_USER_HISTORY_LIMIT;
  return Math.max(1, Math.floor(parsed));
}

function extractTargetUserIdsFromQuestion(
  question: string,
  requesterUserId: string,
): string[] {
  const matches = question.match(/\b\d{5,12}\b/g) || [];
  const ids = [String(requesterUserId ?? "").trim(), ...matches].filter(
    (item) => item.length > 0,
  );
  return [...new Set(ids)].slice(0, 3);
}

function extractGroupHistoryText(raw: any): string {
  const segments = Array.isArray(raw?.message) ? raw.message : [];
  if (segments.length === 0) return String(raw?.raw_message || "").trim();

  const parts: string[] = [];
  for (const seg of segments) {
    if (seg?.type === "text") {
      const text = String(seg?.data?.text || "");
      if (text) parts.push(text);
      continue;
    }
    if (seg?.type === "at") {
      const target =
        seg?.qq || seg?.data?.qq || seg?.data?.id || seg?.data?.user_id;
      if (target === "all" || target === "everyone") parts.push("@全体成员");
      else if (target) parts.push(`@${target}`);
      continue;
    }
    if (seg?.type === "image") {
      parts.push("[image]");
      continue;
    }
  }

  const joined = parts.join(" ").trim();
  return joined || String(raw?.raw_message || "").trim();
}

async function fetchGroupHistoryByMessageIdPaging(
  toolCtx: ToolContext,
  limit: number,
): Promise<ChatMessage[]> {
  if (!toolCtx.groupId || limit <= 0) return [];

  const bot = toolCtx.event?.bot;
  if (!bot) return [];

  const otherBotIds = new Set<string>(
    toolCtx.ctx.bots
      .map((b) => String(b.bot_id))
      .filter((id) => id !== String(bot.bot_id)),
  );

  const collected: ChatMessage[] = [];
  const seenMessageIds = new Set<string>();
  let cursorMessageId = "";
  const maxPages = Math.max(1, Math.ceil(limit / 200) + 5);
  let page = 0;

  while (collected.length < limit && page < maxPages) {
    const remaining = limit - collected.length;
    const pageSize = Math.min(200, remaining);

    let history: HistoryMessage[];
    try {
      history = await bot.getHistory(
        { type: "group", group_id: toolCtx.groupId },
        cursorMessageId || undefined,
        pageSize,
      );
    } catch (err) {
      const errText = String(err);
      if (
        cursorMessageId !== "" &&
        (errText.includes("不存在") ||
          errText.toLowerCase().includes("not exist"))
      ) {
        logger.info(
          `[recall_memory] get_group_msg_history stop at cursor ${cursorMessageId}: ${errText}`,
        );
      } else {
        logger.warn(
          `[recall_memory] get_group_msg_history failed at cursor ${cursorMessageId}: ${errText}`,
        );
      }
      break;
    }

    if (!Array.isArray(history) || history.length === 0) break;

    let oldestMessageId: string | null = null;
    let newAdded = 0;

    for (const raw of history) {
      const rawUserId = String(raw.user_id || "");
      if (rawUserId !== "" && otherBotIds.has(rawUserId)) continue;

      const messageId = String(raw.message_id || "");
      const key =
        messageId !== ""
          ? `mid:${messageId}`
          : `${String(raw.user_id || "unknown")}:${String(raw.time || "0")}:${extractGroupHistoryText(raw)}`;
      if (seenMessageIds.has(key)) continue;
      seenMessageIds.add(key);

      const content = extractGroupHistoryText(raw);
      if (!content.trim()) continue;

      const ts = raw.time ?? Date.now();
      collected.push({
        sessionId: toolCtx.sessionId,
        role: String(raw.user_id) === String(bot.bot_id) ? "assistant" : "user",
        content,
        userId: String(raw.user_id ?? "").trim(),
        userName: raw.nickname || String(raw.user_id ?? "unknown"),
        userRole: "member",
        groupId: toolCtx.groupId,
        timestamp: ts,
        messageId: messageId !== "" ? messageId : undefined,
      });
      newAdded += 1;

      if (
        messageId !== "" &&
        (oldestMessageId === null || messageId < oldestMessageId)
      ) {
        oldestMessageId = messageId;
      }
    }

    if (newAdded === 0 || oldestMessageId === null || oldestMessageId === "")
      break;

    if (oldestMessageId === cursorMessageId) break;
    cursorMessageId = oldestMessageId;
    page += 1;
  }

  collected.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return String(a.messageId ?? "").localeCompare(String(b.messageId ?? ""));
  });

  return collected.length > limit ? collected.slice(-limit) : collected;
}

export function createWebSearchTool(toolCtx: ToolContext): AITool {
  return {
    name: "web_search",
    description:
      "Search the web using SearXNG. Use this for current events, external facts, documentation, or anything not in chat history. " +
      "If facts may be outdated or uncertain, prefer calling this tool over guessing. " +
      "If repeated searches still do not produce a useful answer after about 2-3 attempts, stop searching and give a direct reply based on what you already know. " +
      "This tool can only be called a limited number of times per conversation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Alternative input. Multiple search queries; only the first non-empty query will be used.",
        },
        limit: {
          type: "number",
          description:
            "Max number of results to return. Will be clamped by config maxLimit.",
        },
        time_range: {
          type: "string",
          enum: ["day", "month", "year"],
          description: "Optional time filter for recent results",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional categories, e.g. ["general"], ["news"], ["science"]',
        },
        engines: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional engines, e.g. ["google"], ["bing"], ["duckduckgo"]',
        },
      },
      required: [],
    },
    handler: async (args) =>
      searchWebWithSearxng(toolCtx.config.searxng, args || {}),
  };
}

export function createWebReadPageTool(toolCtx: ToolContext): AITool {
  return {
    name: "web_read_page",
    description:
      "Read a webpage by URL, extract its main content, and compress the content into a short, information-dense passage. " +
      "Use this directly when the user already provides a URL, or combine with web_search when you need to discover relevant pages first. " +
      "web_search and web_read_page are independent: use web_search when you need to discover URLs; use web_read_page directly when the user already gave a URL. " +
      "Only set render_js=true when the page clearly needs JavaScript rendering, because it costs much more CPU and memory.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The http/https URL of the webpage to read",
        },
        render_js: {
          type: "boolean",
          description:
            "Set true only if the page likely requires JavaScript rendering. This uses much more CPU and memory.",
        },
        question: {
          type: "string",
          description:
            "Optional question or focus. The tool will prioritize webpage details relevant to this question.",
        },
      },
      required: ["url"],
    },
    handler: async (args) => {
      try {
        const ai = toolCtx.config.webReader.useWorkingModel
          ? (toolCtx.aiService.getInstanceByRole?.("working") ??
            toolCtx.aiService.getDefault())
          : undefined;
        if (toolCtx.config.webReader.useWorkingModel && !ai) {
          return { success: false, error: "AI instance not available" };
        }
        return await readWebPage(
          ai,
          toolCtx.config.workingModel || toolCtx.config.model,
          toolCtx.config.webReader,
          args || {},
        );
      } catch (err) {
        return { success: false, error: `Failed to read webpage: ${err}` };
      }
    },
  };
}

export function createRecallMemoryTool(toolCtx: ToolContext): AITool {
  return {
    name: "recall_memory",
    description:
      "Ask the memory worker model to retrieve historical chat context for a recall question. " +
      "Use ONLY when there is explicit need to recall past content and the required information is clearly missing from current context. " +
      "Do NOT call recall_memory for every question. " +
      "The worker returns historical logs with timestamps; treat them as past records, not newly sent messages.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The recall question to investigate, e.g. 'What did user 123 mention about travel plans before?'",
        },
      },
      required: ["question"],
    },
    handler: async (args) => {
      const question = String(args?.question || "").trim();
      if (!question) return { success: false, error: "question is required" };

      const ai =
        toolCtx.aiService.getInstanceByRole?.("working") ??
        toolCtx.aiService.getDefault();
      if (!ai) return { success: false, error: "AI instance not available" };

      const groupHistoryLimit = resolveGroupRecallLimit(
        toolCtx.config.memory?.groupHistoryLimit,
      );
      const userHistoryLimit = resolveUserHistoryLimit(
        toolCtx.config.memory?.userHistoryLimit,
      );
      const groupHistoryMessages = await fetchGroupHistoryByMessageIdPaging(
        toolCtx,
        groupHistoryLimit,
      );
      const targetUserIds = extractTargetUserIdsFromQuestion(
        question,
        toolCtx.userId,
      );
      const userHistories: MemoryUserHistoryChunk[] = targetUserIds.map(
        (userId) => ({
          userId,
          messages: toolCtx.db.getMessagesByUser(
            userId,
            toolCtx.sessionId,
            userHistoryLimit,
          ),
        }),
      );

      const retriever = new MemoryRetrieval(
        ai,
        () => toolCtx.config,
        toolCtx.db,
      );
      const answer = await retriever.retrieveByQuestion({
        sessionId: toolCtx.sessionId,
        question,
        nowTimestamp: Date.now(),
        groupHistoryMessages,
        userHistories,
      });
      const queriedAt = new Date().toLocaleString("zh-CN", { hour12: false });
      return {
        success: true,
        queried_at: queriedAt,
        question,
        found: Boolean(answer),
        answer: answer || "",
        group_history_count: groupHistoryMessages.length,
        group_history_limit: groupHistoryLimit,
        user_history_limit: userHistoryLimit,
        user_history_targets: targetUserIds,
        note: answer
          ? "Memory worker retrieved historical context."
          : "Memory worker did not find useful historical context.",
      };
    },
  };
}
