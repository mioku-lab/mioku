import type { AITool } from "mioku";
import type { ToolContext } from "../../types";
import { searchWebWithSearxng } from "../web/searxng";
import { parseWebReadArgs, readWebPage } from "../web/web-reader";

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
    handler: async (args: unknown) =>
      searchWebWithSearxng(toolCtx.config.searxng, args),
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
    handler: async (args: unknown) => {
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
          parseWebReadArgs(args),
        );
      } catch (err) {
        return { success: false, error: `Failed to read webpage: ${err}` };
      }
    },
  };
}
