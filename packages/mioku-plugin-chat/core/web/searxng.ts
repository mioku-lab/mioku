import { logger } from "mioki";
import type { SearxngConfig } from "../../types";

type TimeRange = "day" | "month" | "year";

interface WebSearchArgs {
  query?: string;
  queries?: string[];
  limit?: number;
  time_range?: TimeRange;
  categories?: string[];
  engines?: string[];
}

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

export async function searchWebWithSearxng(
  cfg: SearxngConfig,
  args: WebSearchArgs,
): Promise<WebSearchResult> {
  const fallbackQuery = Array.isArray(args.queries)
    ? args.queries.map((item) => String(item || "").trim()).find(Boolean) || ""
    : "";
  const query = String(args.query || fallbackQuery).trim();
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

  const limit = clampLimit(args.limit, cfg);
  const timeoutMs =
    Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? Math.floor(cfg.timeoutMs)
      : 8000;

  const params = new URLSearchParams({
    q: query,
    format: "json",
  });

  if (args.time_range && ["day", "month", "year"].includes(args.time_range)) {
    params.set("time_range", args.time_range);
  }

  const categories = normalizeArray(args.categories);
  if (categories.length > 0) {
    params.set("categories", categories.join(","));
  }

  const engines = normalizeArray(args.engines);
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

    const data: any = await response.json();
    const rawResults = Array.isArray(data?.results) ? data.results : [];

    const results: SearxngResultItem[] = rawResults
      .slice(0, limit)
      .map((item: any) => {
        const title = String(item?.title || "").trim();
        const url = String(item?.url || "").trim();
        const content = String(item?.content || "").trim();
        const engine = String(
          item?.engine ||
            (Array.isArray(item?.engines) ? item.engines[0] : "") ||
            "",
        ).trim();

        return {
          title: title || undefined,
          url: url || undefined,
          content: content || undefined,
          engine: engine || undefined,
        };
      })
      .filter(
        (item: SearxngResultItem) => item.title || item.url || item.content,
      );

    const total =
      typeof data?.number_of_results === "number"
        ? data.number_of_results
        : rawResults.length;

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
