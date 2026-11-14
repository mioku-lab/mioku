import { logger } from "mioku";
import type { SearxngConfig } from "../../types";
import { readField } from "../../utils/record";

const TIME_RANGES = new Set(["day", "month", "year"]);

interface SearxngResultItem {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

interface WebSearchResult {
  success: boolean;
  query: string;
  results: SearxngResultItem[];
  total?: number;
  error?: string;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function clampLimit(limit: unknown, cfg: SearxngConfig): number {
  const defaultLimit =
    Number.isFinite(cfg.defaultLimit) && cfg.defaultLimit > 0
      ? Math.floor(cfg.defaultLimit)
      : 5;
  const maxLimit =
    Number.isFinite(cfg.maxLimit) && cfg.maxLimit > 0
      ? Math.floor(cfg.maxLimit)
      : 8;

  const requested =
    Number.isFinite(limit) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : defaultLimit;

  return Math.max(1, Math.min(requested, maxLimit));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** args 为模型给的工具参数，字段类型不可信 */
export async function searchWebWithSearxng(
  cfg: SearxngConfig,
  args: unknown,
): Promise<WebSearchResult> {
  const queries = readField(args, "queries");
  const fallbackQuery = Array.isArray(queries)
    ? queries.map((item) => String(item || "").trim()).find(Boolean) || ""
    : "";
  const query = String(readField(args, "query") || fallbackQuery).trim();
  if (!query) {
    return {
      success: false,
      query,
      results: [],
      error: "query is required",
    };
  }

  const baseUrl = normalizeBaseUrl(cfg.baseUrl || "");
  if (!baseUrl) {
    return {
      success: false,
      query,
      results: [],
      error: "SearXNG baseUrl is not configured",
    };
  }

  const limit = clampLimit(readField(args, "limit"), cfg);
  const timeoutMs =
    Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? Math.floor(cfg.timeoutMs)
      : 8000;

  const params = new URLSearchParams({
    q: query,
    format: "json",
  });

  const timeRange = readField(args, "time_range");
  if (typeof timeRange === "string" && TIME_RANGES.has(timeRange)) {
    params.set("time_range", timeRange);
  }

  const categories = normalizeArray(readField(args, "categories"));
  if (categories.length > 0) {
    params.set("categories", categories.join(","));
  }

  const engines = normalizeArray(readField(args, "engines"));
  if (engines.length > 0) {
    params.set("engines", engines.join(","));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}/search?${params.toString()}`;
    logger.info(`[web_search] Query "${query}" -> ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        query,
        results: [],
        error: `SearXNG request failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      };
    }

    const data: unknown = await response.json();
    const resultsField = readField(data, "results");
    const rawResults: unknown[] = Array.isArray(resultsField) ? resultsField : [];

    const results: SearxngResultItem[] = rawResults
      .slice(0, limit)
      .map((item) => {
        const text = (key: string) => String(readField(item, key) || "").trim();
        const engines = readField(item, "engines");
        const engine = String(
          readField(item, "engine") ||
            (Array.isArray(engines) ? engines[0] : "") ||
            "",
        ).trim();

        return {
          title: text("title") || undefined,
          url: text("url") || undefined,
          content: text("content") || undefined,
          engine: engine || undefined,
        };
      })
      .filter((item) => item.title || item.url || item.content);

    const numberOfResults = readField(data, "number_of_results");
    const total =
      typeof numberOfResults === "number" ? numberOfResults : rawResults.length;

    return {
      success: true,
      query,
      results,
      total,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      success: false,
      query,
      results: [],
      error: isAbort ? `Request timeout after ${timeoutMs}ms` : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
