import { logger } from "mioki";
import puppeteer from "puppeteer";
import type { AIInstance } from "mioku";
import type { WebReaderConfig } from "../../types";

type ReadMode = "fetch" | "browser";

export interface WebReadArgs {
  url?: string;
  render_js?: boolean;
  question?: string;
}

interface ExtractedPage {
  finalUrl: string;
  title?: string;
  metaDescription?: string;
  headings: string[];
  text: string;
  contentType?: string;
  statusCode?: number;
  sourceBytes?: number;
  warnings: string[];
}

interface PageSummary {
  title?: string;
  content: string;
  warnings: string[];
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

const BLOCK_TAGS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
];

const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "template",
];

const BOILERPLATE_TAGS = ["nav", "footer", "aside", "header"];

function clampText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trim()}...`;
}

function trimList(
  values: string[],
  maxItems: number,
  maxChars: number,
): string[] {
  const deduped = [
    ...new Set(values.map((item) => normalizeText(item)).filter(Boolean)),
  ];
  return deduped.slice(0, maxItems).map((item) => clampText(item, maxChars));
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (entity, body: string) => {
      const mapped = HTML_ENTITY_MAP[body];
      if (mapped != null) {
        return mapped;
      }

      if (body.startsWith("#x") || body.startsWith("#X")) {
        const codePoint = Number.parseInt(body.slice(2), 16);
        if (Number.isFinite(codePoint)) {
          return String.fromCodePoint(codePoint);
        }
      }

      if (body.startsWith("#")) {
        const codePoint = Number.parseInt(body.slice(1), 10);
        if (Number.isFinite(codePoint)) {
          return String.fromCodePoint(codePoint);
        }
      }

      return entity;
    },
  );
}

function stripTagBlock(html: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "gi",
  );
  return html.replace(pattern, "\n");
}

function stripHtmlTags(html: string): string {
  let result = html;

  for (const tag of NOISE_TAGS) {
    result = stripTagBlock(result, tag);
  }

  for (const tag of BOILERPLATE_TAGS) {
    result = stripTagBlock(result, tag);
  }

  result = result.replace(/<!--[\s\S]*?-->/g, "\n");
  result = result.replace(/<br\s*\/?>/gi, "\n");

  for (const tag of BLOCK_TAGS) {
    const openPattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const closePattern = new RegExp(`<\\/${tag}>`, "gi");
    result = result.replace(openPattern, "\n");
    result = result.replace(closePattern, "\n");
  }

  result = result.replace(/<[^>]+>/g, " ");
  result = decodeHtmlEntities(result);

  return normalizeText(result);
}

function extractTitleFromHtml(html: string): string | undefined {
  const candidates = [
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const text = normalizeText(decodeHtmlEntities(match[1]));
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const patterns = [
    /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i,
    /<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const text = normalizeText(decodeHtmlEntities(match[1]));
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const pattern = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const text = stripHtmlTags(match[2]);
    if (text) {
      headings.push(text);
    }
  }

  return trimList(headings, 10, 120);
}

function pickBestParagraphs(text: string, maxChars: number): string {
  const paragraphs = text
    .split(/\n{1,2}/)
    .map((paragraph, index) => ({
      index,
      text: paragraph.trim(),
    }))
    .filter((paragraph) => paragraph.text.length >= 12);

  if (paragraphs.length === 0) {
    return clampText(text, maxChars);
  }

  if (paragraphs.length <= 8) {
    return clampText(
      paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
      maxChars,
    );
  }

  const scored = paragraphs.map((paragraph) => {
    const value = paragraph.text;
    const punctuationCount = (value.match(/[，。！？；：,.!?;:]/g) || [])
      .length;
    const sentenceCount = (value.match(/[。！？.!?]/g) || []).length;
    const linkLikeCount = (value.match(/https?:\/\/|www\./g) || []).length;
    const separatorCount = (value.match(/[|>•·]/g) || []).length;

    let score = value.length + punctuationCount * 12 + sentenceCount * 20;
    if (value.length < 24) score -= 40;
    score -= linkLikeCount * 40;
    score -= separatorCount * 8;

    return {
      ...paragraph,
      score,
    };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 18)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text);

  return clampText(selected.join("\n\n"), maxChars);
}

function extractHtmlContent(
  html: string,
  cfg: WebReaderConfig,
): Omit<
  ExtractedPage,
  "finalUrl" | "contentType" | "statusCode" | "sourceBytes"
> {
  const title = extractTitleFromHtml(html);
  const metaDescription = extractMetaDescription(html);
  const headings = extractHeadings(html);

  let workingHtml = html;
  for (const tag of NOISE_TAGS) {
    workingHtml = stripTagBlock(workingHtml, tag);
  }

  const bodyMatch = workingHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] || workingHtml;
  const plainText = stripHtmlTags(bodyHtml);
  const pickedText = pickBestParagraphs(plainText, cfg.maxExtractedChars);
  const warnings: string[] = [];

  if (pickedText.length < 180) {
    warnings.push(
      "Extracted content is sparse. The page may rely on JavaScript rendering.",
    );
  }

  return {
    title,
    metaDescription,
    headings,
    text: pickedText,
    warnings,
  };
}

function normalizeUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Local network URLs are not allowed");
  }

  return url.toString();
}

function parseCharset(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset=([^;]+)/i);
  return match?.[1]?.trim() || null;
}

function createTextDecoder(charset: string | null): TextDecoder {
  if (!charset) {
    return new TextDecoder("utf-8");
  }

  try {
    return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]);
  } catch {
    return new TextDecoder("utf-8");
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }
    return { text, bytes };
  }

  const decoder = createTextDecoder(
    parseCharset(response.headers.get("content-type")),
  );
  let bytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, bytes };
}

function isAllowedContentType(
  contentType: string | null,
  cfg: WebReaderConfig,
): boolean {
  if (!contentType) {
    return true;
  }

  const normalized = contentType.toLowerCase();
  return cfg.allowedContentTypes.some((allowed) =>
    normalized.startsWith(allowed.toLowerCase()),
  );
}

async function fetchPage(
  url: string,
  cfg: WebReaderConfig,
): Promise<ExtractedPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    if (!isAllowedContentType(contentType, cfg)) {
      throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
    }

    const finalUrl = response.url || url;
    const { text, bytes } = await readResponseText(response, cfg.maxHtmlBytes);
    const normalizedContentType = (contentType || "").toLowerCase();

    if (normalizedContentType.startsWith("text/plain")) {
      const normalizedText = clampText(
        normalizeText(text),
        cfg.maxExtractedChars,
      );
      return {
        finalUrl,
        title: undefined,
        metaDescription: undefined,
        headings: [],
        text: normalizedText,
        contentType: contentType || undefined,
        statusCode: response.status,
        sourceBytes: bytes,
        warnings:
          normalizedText.length < 180 ? ["Extracted content is sparse."] : [],
      };
    }

    const extracted = extractHtmlContent(text, cfg);
    return {
      finalUrl,
      contentType: contentType || undefined,
      statusCode: response.status,
      sourceBytes: bytes,
      ...extracted,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new Error(
      isAbort ? `Request timeout after ${cfg.timeoutMs}ms` : String(err),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function renderPage(
  url: string,
  cfg: WebReaderConfig,
): Promise<ExtractedPage> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.browserTimeoutMs,
    });
    await page
      .waitForNetworkIdle({
        idleTime: 500,
        timeout: Math.min(cfg.browserTimeoutMs, 3000),
      })
      .catch(() => undefined);

    const pageUrl = page.url();
    const contentType = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const contentTypeValue = doc?.contentType;
      return typeof contentTypeValue === "string" ? contentTypeValue : "";
    });

    const extracted = await page.evaluate((maxChars: number) => {
      const doc = (globalThis as any).document;
      const textOf = (node: any): string =>
        String(node?.innerText || node?.textContent || "")
          .replace(/\r/g, "")
          .replace(/[ \t\f\v\u00a0]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .split("\n")
          .map((line: string) => line.trim())
          .filter(Boolean)
          .join("\n")
          .trim();

      const metaDescription =
        doc
          ?.querySelector(
            'meta[name="description"], meta[property="og:description"]',
          )
          ?.getAttribute("content") || "";

      const headings = Array.from(doc?.querySelectorAll("h1, h2, h3") || [])
        .map((node: any) => textOf(node))
        .filter(Boolean)
        .slice(0, 10);

      const candidates = Array.from(
        doc?.querySelectorAll("article, main, [role='main'], section, div") ||
          [],
      ).slice(0, 300) as any[];

      let bestNode = doc?.querySelector("article, main, [role='main']") || null;
      let bestScore = -1;

      for (const node of candidates) {
        const text = textOf(node);
        if (text.length < 120) continue;

        const paragraphCount = node.querySelectorAll
          ? node.querySelectorAll("p").length
          : 0;
        const linkTextLength = Array.from(node.querySelectorAll?.("a") || [])
          .map((link: any) => textOf(link).length)
          .reduce((sum: number, item: number) => sum + item, 0);

        const linkDensity = text.length > 0 ? linkTextLength / text.length : 1;
        const score =
          text.length + paragraphCount * 80 - Math.round(linkDensity * 600);

        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }

      const bestText = textOf(bestNode || doc?.body);
      return {
        title: String(doc?.title || "").trim(),
        metaDescription: String(metaDescription).trim(),
        headings,
        text:
          bestText.length > maxChars
            ? `${bestText.slice(0, maxChars).trim()}...`
            : bestText,
      };
    }, cfg.maxExtractedChars);

    const warnings: string[] = [];
    if (extracted.text.length < 180) {
      warnings.push("Rendered page still contains little readable text.");
    }

    return {
      finalUrl: pageUrl || url,
      title: normalizeText(extracted.title),
      metaDescription: normalizeText(extracted.metaDescription),
      headings: trimList(extracted.headings, 10, 120),
      text: normalizeText(extracted.text),
      contentType: contentType || "text/html",
      sourceBytes: undefined,
      statusCode: undefined,
      warnings,
    };
  } catch (err) {
    throw new Error(
      `Browser rendering failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }
}

function buildSummarizerPrompt(): string {
  return `You clean webpage content for another LLM.

Return strict JSON only:
{
  "title": "optional better title",
  "content": "cleaned main webpage content",
  "warnings": ["warning 1"]
}

Rules:
- Do not summarize, compress, or rewrite the page into an abstract overview.
- Your primary job is to remove irrelevant material while preserving the main body content as fully as possible.
- Keep the page's original facts, details, narrative flow, examples, and conclusions whenever they belong to the main content.
- Keep names, numbers, dates, versions, entities, relationships, conclusions, examples, and caveats whenever they appear in the source.
- Remove ads, navigation, repeated boilerplate, cookie text, subscription prompts, decorative text, and other non-content noise first.
- Remove obviously duplicated text, but otherwise prefer retaining content over shortening it.
- If a question is provided, make sure relevant content is preserved, but do not drop other important main-page information just to focus on that question.
- warnings: include uncertainty, missing context, paywall/login issues, sparse extraction, or likely JS-rendering gaps.
- Do not use markdown. Output valid JSON only.`;
}

function parseJsonContent(content: string): any {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const payload = jsonMatch?.[0] || content;
  return JSON.parse(payload);
}

async function summarizePage(
  ai: AIInstance,
  model: string,
  page: ExtractedPage,
  cfg: WebReaderConfig,
  question?: string,
): Promise<PageSummary> {
  const contentParts = [
    page.title ? `Title: ${page.title}` : "",
    page.metaDescription ? `Meta description: ${page.metaDescription}` : "",
    page.headings.length > 0 ? `Headings:\n${page.headings.join("\n")}` : "",
    question ? `Question focus: ${question.trim()}` : "",
    `Readable content:\n${page.text}`,
  ].filter(Boolean);

  const userContent = contentParts.join("\n\n");

  try {
    const response = await ai.complete({
      model,
      messages: [
        {
          role: "system",
          content: buildSummarizerPrompt(),
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      temperature: 0.2,
    });

    if (!response.content) {
      throw new Error("Model returned empty response");
    }

    const parsed = parseJsonContent(response.content);
    const title = normalizeText(String(parsed.title || page.title || ""));
    const content = normalizeText(
      String(parsed.content || parsed.summary || ""),
    );
    const warnings = trimList(
      [
        ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []),
        ...page.warnings,
      ],
      6,
      180,
    );

    return {
      title: title || page.title,
      content: content || page.text,
      warnings,
    };
  } catch (err) {
    logger.warn(`[web-reader] Failed to summarize with model: ${err}`);
    return {
      title: page.title,
      content: page.text,
      warnings: trimList(
        [
          ...page.warnings,
          "Model summarization failed; returned fallback extraction.",
        ],
        6,
        180,
      ),
    };
  }
}

export async function readWebPage(
  ai: AIInstance | undefined,
  model: string,
  cfg: WebReaderConfig,
  args: WebReadArgs,
): Promise<Record<string, unknown>> {
  if (!cfg.enabled) {
    return {
      success: false,
      error: "Web reader is disabled in config",
    };
  }

  const rawUrl = String(args.url || "").trim();
  if (!rawUrl) {
    return {
      success: false,
      error: "url is required",
    };
  }

  try {
    const normalizedUrl = normalizeUrl(rawUrl);
    const mode: ReadMode = args.render_js ? "browser" : "fetch";

    logger.info(`[web-reader] Reading ${normalizedUrl} via ${mode}`);

    const page =
      mode === "browser"
        ? await renderPage(normalizedUrl, cfg)
        : await fetchPage(normalizedUrl, cfg);

    if (!page.text) {
      return {
        success: false,
        url: normalizedUrl,
        finalUrl: page.finalUrl,
        mode,
        error: "No readable content extracted from page",
      };
    }

    const summary =
      cfg.useWorkingModel && ai
        ? await summarizePage(ai, model, page, cfg, args.question)
        : {
            title: page.title,
            content: page.text,
            warnings: page.warnings,
          };

    return {
      success: true,
      url: normalizedUrl,
      finalUrl: page.finalUrl,
      mode,
      title: summary.title || page.title,
      content: summary.content,
      headings: page.headings,
      meta_description: page.metaDescription,
      warnings: summary.warnings,
      content_type: page.contentType,
      status_code: page.statusCode,
      content_stats: {
        source_bytes: page.sourceBytes,
        extracted_chars: page.text.length,
        processed_chars: summary.content.length,
        processed_by_working_model: Boolean(cfg.useWorkingModel && ai),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
