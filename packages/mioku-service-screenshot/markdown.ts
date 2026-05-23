import { createRequire } from "node:module";
import type { MarkdownScreenshotOptions } from "./types";

interface MarkdownRendererLike {
  render(source: string): string;
  inline?: { ruler?: { after: (...args: any[]) => void } };
  block?: { ruler?: { after: (...args: any[]) => void } };
  renderer?: {
    rules?: Record<string, (...args: any[]) => string>;
  };
}

interface MarkdownRuntimeDeps {
  MarkdownItCtor?: new (options: Record<string, any>) => MarkdownRendererLike;
  hljs?: {
    getLanguage?: (lang: string) => unknown;
    highlight?: (
      code: string,
      options: { language: string; ignoreIllegals?: boolean },
    ) => { value: string };
    highlightAuto?: (code: string) => { value: string };
  };
  katex?: {
    renderToString: (
      source: string,
      options: {
        displayMode: boolean;
        output: "mathml";
        throwOnError: boolean;
        strict: "ignore";
        trust: boolean;
      },
    ) => string;
  };
}

const require = createRequire(import.meta.url);
const runtimeDeps = loadRuntimeDeps();
const markdownRenderer = createMarkdownRenderer(runtimeDeps);

function loadRuntimeDeps(): MarkdownRuntimeDeps {
  const deps: MarkdownRuntimeDeps = {};

  try {
    const module = require("markdown-it");
    deps.MarkdownItCtor = (module?.default || module) as MarkdownRuntimeDeps["MarkdownItCtor"];
  } catch {}

  try {
    const module = require("highlight.js");
    deps.hljs = (module?.default || module) as MarkdownRuntimeDeps["hljs"];
  } catch {}

  try {
    const module = require("katex");
    deps.katex = (module?.default || module) as MarkdownRuntimeDeps["katex"];
    require("katex/contrib/mhchem");
  } catch {}

  return deps;
}

function createMarkdownRenderer(deps: MarkdownRuntimeDeps): MarkdownRendererLike {
  if (!deps.MarkdownItCtor) {
    return {
      render(source: string): string {
        return `<pre class="md-fallback-text">${escapeHtml(source)}</pre>`;
      },
    };
  }

  const renderer = new deps.MarkdownItCtor({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
    highlight(code: string, language: string) {
      return renderHighlightedCode(code, language, deps.hljs);
    },
  });

  installMathSupport(renderer);

  if (renderer.renderer?.rules) {
    renderer.renderer.rules.link_open = (
      tokens: any[],
      idx: number,
      options: any,
      _env: any,
      self: any,
    ) => {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
      return self.renderToken(tokens, idx, options);
    };

    renderer.renderer.rules.image = (tokens: any[], idx: number) => {
      const token = tokens[idx];
      const altText = escapeHtml(token.content || "图片");
      return `<figure class="md-image-placeholder">已省略图片资源：${altText}</figure>`;
    };
  }

  return renderer;
}

function renderHighlightedCode(
  code: string,
  language: string,
  hljs: MarkdownRuntimeDeps["hljs"],
): string {
  const normalizedLanguage = String(language || "")
    .trim()
    .toLowerCase();

  if (
    normalizedLanguage &&
    hljs?.getLanguage?.(normalizedLanguage) &&
    hljs?.highlight
  ) {
    const highlighted = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true,
    }).value;
    return buildHighlightedCodeBlock(highlighted, normalizedLanguage);
  }

  if (hljs?.highlightAuto) {
    const highlighted = hljs.highlightAuto(code).value;
    const label = normalizedLanguage || "code";
    return buildHighlightedCodeBlock(highlighted, label);
  }

  return buildHighlightedCodeBlock(escapeHtml(code), normalizedLanguage || "code");
}

export function renderMarkdownAsHtml(markdown: string): {
  html: string;
  width: number;
  height: number;
} {
  const renderedMarkdown = markdownRenderer.render(markdown);
  const isNightMode = checkNightMode();
  const theme = isNightMode ? buildDarkTheme() : buildLightTheme();
  const viewport = estimateMarkdownViewport(markdown);
  const html = `
    <style>
      :root {
        color-scheme: ${isNightMode ? "dark" : "light"};
      }
      html {
        background: transparent;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        background: ${theme.pageBg};
        color: ${theme.foreground};
        width: ${viewport.width}px;
      }
      .md-page {
        position: relative;
        width: ${viewport.width}px;
        padding: ${viewport.pagePadding}px;
        overflow: hidden;
        isolation: isolate;
      }
      .md-page::before {
        content: "";
        position: absolute;
        inset: 0;
        background: ${theme.pageAccent};
        pointer-events: none;
        z-index: 0;
      }
      .md-page::after {
        content: "";
        position: absolute;
        inset: 0;
        background-image: ${theme.pageGrid};
        background-size: 30px 30px;
        opacity: ${isNightMode ? "0.85" : "0.75"};
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.82), transparent 100%);
        pointer-events: none;
        z-index: 0;
      }
      .md-shell {
        position: relative;
        z-index: 1;
        width: 100%;
        margin: 0;
        border-radius: 28px;
        border: 1px solid ${theme.shellBorder};
        background: ${theme.shellBg};
        box-shadow: ${theme.shellShadow};
        backdrop-filter: blur(18px);
        overflow: hidden;
      }
      .md-body {
        padding: 30px 32px 34px;
      }
      .markdown-body {
        color: ${theme.foreground};
        font-size: 16px;
        line-height: 1.82;
      }
      .markdown-body > *:first-child {
        margin-top: 0;
      }
      .markdown-body > *:last-child {
        margin-bottom: 0;
      }
      .markdown-body h1,
      .markdown-body h2,
      .markdown-body h3,
      .markdown-body h4 {
        color: ${theme.heading};
        margin: 1.4em 0 0.55em;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      .markdown-body h1 {
        font-size: 1.9em;
      }
      .markdown-body h2 {
        font-size: 1.46em;
        padding-bottom: 0.32em;
        border-bottom: 1px solid ${theme.divider};
      }
      .markdown-body h3 {
        font-size: 1.22em;
      }
      .markdown-body p,
      .markdown-body ul,
      .markdown-body ol,
      .markdown-body blockquote,
      .markdown-body table,
      .markdown-body pre {
        margin: 0 0 1em;
      }
      .markdown-body ul,
      .markdown-body ol {
        padding-left: 1.4em;
      }
      .markdown-body li + li {
        margin-top: 0.38em;
      }
      .markdown-body strong {
        color: ${theme.heading};
      }
      .markdown-body a {
        color: ${theme.link};
        text-decoration: none;
        border-bottom: 1px solid ${theme.linkUnderline};
      }
      .markdown-body hr {
        margin: 1.5em 0;
        border: 0;
        border-top: 1px solid ${theme.divider};
      }
      .markdown-body blockquote {
        padding: 14px 16px;
        border-left: 4px solid ${theme.quoteBorder};
        border-radius: 0 18px 18px 0;
        background: ${theme.quoteBg};
        color: ${theme.quoteText};
      }
      .markdown-body table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid ${theme.tableBorder};
        background: ${theme.tableBg};
      }
      .markdown-body thead {
        background: ${theme.tableHeadBg};
      }
      .markdown-body th,
      .markdown-body td {
        padding: 12px 14px;
        border-bottom: 1px solid ${theme.tableBorder};
        text-align: left;
        vertical-align: top;
      }
      .markdown-body tr:last-child td {
        border-bottom: none;
      }
      .markdown-body code {
        font-family: "JetBrains Mono", "SFMono-Regular", "Consolas", "Liberation Mono", monospace;
      }
      .markdown-body :not(pre) > code {
        padding: 0.16em 0.42em;
        border-radius: 8px;
        background: ${theme.inlineCodeBg};
        color: ${theme.inlineCodeText};
        font-size: 0.92em;
      }
      .md-code-block {
        margin: 1.1em 0 1.25em;
        border-radius: 22px;
        overflow: hidden;
        border: 1px solid ${theme.codeBorder};
        background: ${theme.codeBg};
        box-shadow: ${theme.codeShadow};
      }
      .md-code-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 16px;
        background: ${theme.codeTopbarBg};
        border-bottom: 1px solid ${theme.codeBorder};
        color: ${theme.codeTopbarText};
        font-size: 12px;
      }
      .md-code-dots {
        display: inline-flex;
        gap: 6px;
      }
      .md-code-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }
      .md-code-dot[data-dot="1"] { background: ${theme.dotA}; }
      .md-code-dot[data-dot="2"] { background: ${theme.dotB}; }
      .md-code-dot[data-dot="3"] { background: ${theme.dotC}; }
      .md-code-label {
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .md-code-block pre {
        margin: 0;
        padding: 10px 20px 16px;
        overflow: auto;
        background: transparent;
        line-height: 1.62;
      }
      .md-code-block code {
        display: block;
        margin: 0;
        font-size: 13px;
        line-height: 1.62;
      }
      .md-image-placeholder {
        margin: 1em 0;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px dashed ${theme.divider};
        color: ${theme.muted};
        background: ${theme.quoteBg};
      }
      .md-fallback-text {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 15px;
        line-height: 1.8;
      }
      .markdown-body .md-math-inline {
        display: inline-flex;
        align-items: baseline;
        max-width: 100%;
        margin: 0 0.04em;
        line-height: 1;
        vertical-align: -0.08em;
      }
      .markdown-body .md-math-inline > math {
        font-size: 0.98em;
        line-height: 1;
        color: ${theme.mathText};
      }
      .markdown-body .md-math-block {
        margin: 1.2em 0 1.35em;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px solid ${theme.mathBlockBorder};
        background: ${theme.mathBlockBg};
        overflow-x: auto;
        text-align: left;
      }
      .markdown-body .md-math-block > math {
        display: block;
        min-width: max-content;
        font-size: 1em;
        line-height: 1.28;
        color: ${theme.mathText};
      }
      .markdown-body math {
        font-family: ${theme.mathFontFamily};
        font-style: normal;
        letter-spacing: normal;
        word-spacing: normal;
        font-weight: 400;
        font-kerning: normal;
        text-rendering: optimizeLegibility;
      }
      .markdown-body math * {
        font-family: ${theme.mathFontFamily};
        font-style: normal;
        font-weight: inherit;
      }
      .markdown-body math[display="block"] {
        margin: 0;
      }
      .md-math-fallback,
      .md-math-fallback-inline {
        font-family: "JetBrains Mono", "SFMono-Regular", "Consolas", "Liberation Mono", monospace;
      }
      .md-math-fallback {
        margin: 1.2em 0 1.35em;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px dashed ${theme.mathInlineBorder};
        background: ${theme.mathBlockBg};
        color: ${theme.muted};
        white-space: pre-wrap;
      }
      .md-math-fallback-inline {
        padding: 0.14em 0.42em;
        border-radius: 8px;
        border: 1px solid ${theme.mathInlineBorder};
        background: ${theme.mathInlineBg};
        color: ${theme.mathText};
      }
      .hljs {
        color: ${theme.hljsText};
      }
      .hljs-comment,
      .hljs-quote {
        color: ${theme.hljsComment};
      }
      .hljs-keyword,
      .hljs-selector-tag,
      .hljs-subst {
        color: ${theme.hljsKeyword};
      }
      .hljs-number,
      .hljs-literal,
      .hljs-variable,
      .hljs-template-variable,
      .hljs-tag .hljs-attr {
        color: ${theme.hljsNumber};
      }
      .hljs-string,
      .hljs-doctag {
        color: ${theme.hljsString};
      }
      .hljs-title,
      .hljs-section,
      .hljs-selector-id {
        color: ${theme.hljsTitle};
      }
      .hljs-type,
      .hljs-class .hljs-title {
        color: ${theme.hljsType};
      }
      .hljs-attr,
      .hljs-attribute,
      .hljs-name {
        color: ${theme.hljsAttr};
      }
      .hljs-built_in,
      .hljs-builtin-name {
        color: ${theme.hljsBuiltIn};
      }
      .hljs-symbol,
      .hljs-bullet,
      .hljs-link {
        color: ${theme.hljsSymbol};
      }
      .hljs-emphasis {
        font-style: italic;
      }
      .hljs-strong {
        font-weight: 700;
      }
    </style>
    <div class="md-page">
      <section class="md-shell">
        <div class="md-body">
          <article class="markdown-body">${renderedMarkdown}</article>
        </div>
      </section>
    </div>
  `;

  return {
    html,
    width: viewport.width,
    height: viewport.height,
  };
}

export function buildMarkdownScreenshotOptions(
  markdown: string,
  options?: MarkdownScreenshotOptions,
): { html: string; options: MarkdownScreenshotOptions } {
  const viewport = estimateMarkdownViewport(markdown);
  const rendered = renderMarkdownAsHtml(markdown);
  return {
    html: rendered.html,
    options: {
      ...options,
      width: options?.width || viewport.width,
      height: options?.height || viewport.height,
      fullPage: options?.fullPage ?? true,
      type: options?.type || "png",
    },
  };
}

function installMathSupport(md: any): void {
  if (!md?.inline?.ruler || !md?.block?.ruler || !md?.renderer?.rules) {
    return;
  }
  md.inline.ruler.after("escape", "math_inline", mathInlineRule);
  md.block.ruler.after("blockquote", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens: any[], idx: number) =>
    renderMath(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens: any[], idx: number) =>
    `${renderMath(tokens[idx].content, true)}\n`;
}

function mathInlineRule(state: any, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;

  if (src.charCodeAt(start) !== 0x24) {
    return false;
  }

  if (src.charCodeAt(start + 1) === 0x24) {
    return false;
  }

  const prevChar = start > 0 ? src.charCodeAt(start - 1) : 0;
  const nextChar = src.charCodeAt(start + 1);

  if (isAsciiDigit(prevChar) || nextChar === 0x20 || nextChar === 0x09) {
    return false;
  }

  let match = start + 1;
  while ((match = src.indexOf("$", match)) !== -1) {
    if (src.charCodeAt(match - 1) === 0x5c) {
      match += 1;
      continue;
    }

    const content = src.slice(start + 1, match);
    if (!content.trim() || /[\n\r]/.test(content)) {
      return false;
    }

    const afterChar = src.charCodeAt(match + 1);
    if (isAsciiDigit(afterChar)) {
      match += 1;
      continue;
    }

    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
    }

    state.pos = match + 1;
    return true;
  }

  return false;
}

function mathBlockRule(
  state: any,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const firstLine = state.src.slice(start, max);

  if (!firstLine.startsWith("$$")) {
    return false;
  }

  if (silent) {
    return true;
  }

  const firstRest = firstLine.slice(2);
  let content = "";
  let nextLine = startLine;
  let closed = false;

  const sameLineClose = firstRest.indexOf("$$");
  if (sameLineClose >= 0) {
    content = firstRest.slice(0, sameLineClose);
    closed = true;
  } else {
    content = firstRest;
    for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const lineText = state.src.slice(lineStart, lineMax);
      const closeIndex = lineText.indexOf("$$");
      if (closeIndex >= 0) {
        content += `\n${lineText.slice(0, closeIndex)}`;
        closed = true;
        break;
      }
      content += `\n${lineText}`;
    }
  }

  if (!closed) {
    return false;
  }

  state.line = nextLine + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, state.line];
  return true;
}

function renderMath(source: string, displayMode: boolean): string {
  const normalized = normalizeMathSource(source);

  if (!runtimeDeps.katex?.renderToString) {
    const fallback = escapeHtml(source);
    return displayMode
      ? `<pre class="md-math-fallback">${fallback}</pre>`
      : `<code class="md-math-fallback-inline">${fallback}</code>`;
  }

  try {
    const rendered = runtimeDeps.katex.renderToString(normalized, {
      displayMode,
      output: "mathml",
      throwOnError: true,
      strict: "ignore",
      trust: false,
    });
    return displayMode
      ? `<div class="md-math-block">${rendered}</div>`
      : `<span class="md-math-inline">${rendered}</span>`;
  } catch {
    const fallback = escapeHtml(source);
    return displayMode
      ? `<pre class="md-math-fallback">${fallback}</pre>`
      : `<code class="md-math-fallback-inline">${fallback}</code>`;
  }
}

function normalizeMathSource(source: string): string {
  const replacements: Record<string, string> = {
    "（": "(",
    "）": ")",
    "｛": "{",
    "｝": "}",
    "［": "[",
    "］": "]",
    "，": ",",
    "。": ".",
    "：": ":",
    "；": ";",
    "！": "!",
    "？": "?",
    "＝": "=",
    "＋": "+",
    "－": "-",
    "×": "\\times ",
    "÷": "\\div ",
    "／": "/",
    "％": "%",
    "＾": "^",
    "＿": "_",
    "　": " ",
  };

  return Array.from(String(source || ""))
    .map((char) => replacements[char] ?? char)
    .join("");
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function buildHighlightedCodeBlock(codeHtml: string, language: string): string {
  return `<figure class="md-code-block">
    <figcaption class="md-code-topbar">
      <span class="md-code-dots">
        <i class="md-code-dot" data-dot="1"></i>
        <i class="md-code-dot" data-dot="2"></i>
        <i class="md-code-dot" data-dot="3"></i>
      </span>
      <span class="md-code-label">${escapeHtml(language || "code")}</span>
    </figcaption>
    <pre><code class="hljs language-${escapeHtml(language || "code")}">${codeHtml}</code></pre>
  </figure>`;
}

function estimateMarkdownViewport(markdown: string): {
  width: number;
  height: number;
  pagePadding: number;
} {
  const normalized = String(markdown || "").replace(/\r/g, "");
  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const longestLine = nonEmptyLines.reduce(
    (max, line) => Math.max(max, Array.from(line).length),
    0,
  );
  const lineCount = nonEmptyLines.length;
  const hasCodeBlock = /```/.test(normalized);
  const hasTable =
    /\|/.test(normalized) && /^\s*\|?[-: ]+\|[-|: ]+\s*$/m.test(normalized);
  const hasBlockquote = /^\s*>/m.test(normalized);
  const hasList = /^\s*(?:[-*+]|\d+\.)\s+/m.test(normalized);

  let width = 640;
  if (lineCount >= 10) width += 30;
  if (lineCount >= 22) width += 30;
  if (longestLine >= 36) width += 40;
  if (longestLine >= 64) width += 60;
  if (longestLine >= 96) width += 70;
  if (hasCodeBlock) width = Math.max(width, 820);
  if (hasTable) width = Math.max(width, 920);
  if (hasList || hasBlockquote) width = Math.max(width, 700);
  width = clamp(width, 560, 980);

  let height = 260;
  if (lineCount >= 5) height = 320;
  if (lineCount >= 10) height = 420;
  if (lineCount >= 18) height = 520;
  if (lineCount >= 28) height = 620;
  if (hasCodeBlock) height += 80;
  if (hasTable) height += 60;
  height = clamp(height, 240, 860);

  const pagePadding = width >= 860 ? 26 : 22;

  return { width, height, pagePadding };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function checkNightMode(): boolean {
  const hour = new Date().getHours();
  return hour >= 19 || hour < 7;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return String(text || "").replace(/[&<>"']/g, (char) => map[char]);
}

function buildLightTheme() {
  return {
    pageBg: "linear-gradient(180deg, #eefcfb 0%, #ecfbfe 48%, #f6fbff 100%)",
    pageAccent:
      "radial-gradient(circle at 10% 12%, rgba(54, 211, 196, 0.22), transparent 30%), radial-gradient(circle at 86% 10%, rgba(56, 189, 248, 0.18), transparent 28%), radial-gradient(circle at 50% 100%, rgba(45, 212, 191, 0.12), transparent 38%)",
    pageGrid:
      "linear-gradient(rgba(13, 148, 136, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(13, 148, 136, 0.06) 1px, transparent 1px)",
    shellBg: "rgba(255, 255, 255, 0.78)",
    shellBorder: "rgba(132, 204, 196, 0.35)",
    shellShadow: "0 34px 80px rgba(30, 91, 95, 0.18)",
    divider: "rgba(148, 213, 209, 0.42)",
    foreground: "#12343a",
    heading: "#0f2d34",
    muted: "rgba(18, 52, 58, 0.72)",
    badgeBgLight: "rgba(245, 158, 11, 0.14)",
    badgeBorderLight: "rgba(217, 119, 6, 0.24)",
    badgeTextLight: "#92400e",
    link: "#0f766e",
    linkUnderline: "rgba(15, 118, 110, 0.24)",
    quoteBg: "rgba(226, 248, 246, 0.8)",
    quoteBorder: "#2dd4bf",
    quoteText: "#275a60",
    tableBg: "rgba(255, 255, 255, 0.82)",
    tableHeadBg: "rgba(226, 248, 246, 0.88)",
    tableBorder: "rgba(148, 213, 209, 0.45)",
    mathFontFamily:
      '"STIX Two Text", "Cambria Math", "Times New Roman", "Noto Serif SC", "Source Han Serif SC", serif',
    mathText: "#13424a",
    mathInlineBg: "rgba(232, 250, 248, 0.92)",
    mathInlineBorder: "rgba(148, 213, 209, 0.52)",
    mathBlockBg: "rgba(232, 250, 248, 0.88)",
    mathBlockBorder: "rgba(134, 208, 202, 0.58)",
    inlineCodeBg: "rgba(212, 246, 242, 0.95)",
    inlineCodeText: "#115e59",
    codeBg: "#f6fffe",
    codeBorder: "rgba(125, 211, 200, 0.24)",
    codeShadow: "0 18px 34px rgba(37, 99, 102, 0.12)",
    codeTopbarBg: "rgba(226, 248, 246, 0.88)",
    codeTopbarText: "rgba(17, 94, 89, 0.76)",
    dotA: "#fb7185",
    dotB: "#facc15",
    dotC: "#34d399",
    hljsText: "#17434a",
    hljsComment: "#6b8790",
    hljsKeyword: "#0f766e",
    hljsNumber: "#2563eb",
    hljsString: "#b45309",
    hljsTitle: "#7c3aed",
    hljsType: "#be185d",
    hljsAttr: "#0f766e",
    hljsBuiltIn: "#0284c7",
    hljsSymbol: "#c2410c",
  };
}

function buildDarkTheme() {
  return {
    pageBg: "linear-gradient(180deg, #07141c 0%, #0b1c25 52%, #102730 100%)",
    pageAccent:
      "radial-gradient(circle at 18% 14%, rgba(76, 201, 191, 0.18), transparent 34%), radial-gradient(circle at 82% 10%, rgba(34, 211, 238, 0.12), transparent 28%), radial-gradient(circle at 50% 100%, rgba(45, 212, 191, 0.1), transparent 42%)",
    pageGrid:
      "linear-gradient(rgba(151, 214, 210, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(151, 214, 210, 0.04) 1px, transparent 1px)",
    shellBg: "rgba(9, 24, 32, 0.72)",
    shellBorder: "rgba(56, 189, 248, 0.14)",
    shellShadow: "0 34px 80px rgba(0, 0, 0, 0.36)",
    divider: "rgba(77, 132, 146, 0.3)",
    foreground: "#dcf7f5",
    heading: "#f2fffe",
    muted: "rgba(206, 241, 239, 0.72)",
    badgeBgDark: "rgba(45, 212, 191, 0.14)",
    badgeBorderDark: "rgba(45, 212, 191, 0.2)",
    badgeTextDark: "#7fe9dd",
    link: "#67e8f9",
    linkUnderline: "rgba(103, 232, 249, 0.24)",
    quoteBg: "rgba(11, 43, 54, 0.72)",
    quoteBorder: "#2dd4bf",
    quoteText: "#a8f5ec",
    tableBg: "rgba(9, 29, 39, 0.82)",
    tableHeadBg: "rgba(12, 43, 53, 0.92)",
    tableBorder: "rgba(75, 132, 146, 0.36)",
    mathFontFamily:
      '"STIX Two Text", "Cambria Math", "Times New Roman", "Noto Serif SC", "Source Han Serif SC", serif',
    mathText: "#d6f6f1",
    mathInlineBg: "rgba(18, 52, 65, 0.9)",
    mathInlineBorder: "rgba(82, 156, 171, 0.42)",
    mathBlockBg: "rgba(15, 44, 56, 0.84)",
    mathBlockBorder: "rgba(83, 158, 173, 0.44)",
    inlineCodeBg: "rgba(16, 56, 70, 0.9)",
    inlineCodeText: "#8ef1e3",
    codeBg: "#071722",
    codeBorder: "rgba(56, 189, 248, 0.18)",
    codeShadow: "0 24px 46px rgba(0, 0, 0, 0.34)",
    codeTopbarBg: "rgba(10, 34, 46, 0.94)",
    codeTopbarText: "rgba(155, 226, 222, 0.74)",
    dotA: "#fb7185",
    dotB: "#facc15",
    dotC: "#34d399",
    hljsText: "#d8f6ff",
    hljsComment: "#6f9aa6",
    hljsKeyword: "#5eead4",
    hljsNumber: "#7dd3fc",
    hljsString: "#fdba74",
    hljsTitle: "#c4b5fd",
    hljsType: "#f9a8d4",
    hljsAttr: "#5eead4",
    hljsBuiltIn: "#67e8f9",
    hljsSymbol: "#fda4af",
  };
}
