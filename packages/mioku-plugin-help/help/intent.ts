/**
 * Help intent resolution and keyword matching.
 *
 * `resolveHelpImageIntent` parses a chat message into one of four actions:
 * "show overview", "show detail for plugin X", "we don't recognize this
 * plugin", or "not a help command at all". Matching is fuzzy: we accept
 * plugin names, titles, command aliases, and Chinese/English substrings.
 */

import type { CommandRole, PluginHelp } from "mioku";
import { canInvokeCommand } from "./role";
import { STOPWORDS } from "./role-config";
import type {
  HelpImageIntent,
  HelpKeywordCandidate,
  HelpRenderableEntry,
} from "./types";

/**
 * Strip the leading command marker (`#`, `/`) and trailing punctuation,
 * then collapse to a comparable form. Returns "" for empty input.
 */
function sanitizeKeyword(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[#/\s]+/, "")
    .replace(/[。.!！?？,，:：；;]+$/g, "");
}

/** Lowercase + strip everything that isn't a-z, 0-9, or CJK. */
function normalizeForMatch(value: string): string {
  const parts = String(value || "")
    .toLowerCase()
    .match(/[a-z0-9\u4e00-\u9fa5]+/gi);

  return parts ? parts.join("") : "";
}

/** Pull every token of length ≥ 2 that isn't a stop-word. */
function extractMatchTokens(text: string): string[] {
  const rawTokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9\u4e00-\u9fa5]+/gi);

  if (!rawTokens) {
    return [];
  }

  const tokens = rawTokens
    .map((token) => normalizeForMatch(token))
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token));

  return Array.from(new Set(tokens));
}

/**
 * The first whitespace-separated token of a command, with the `#` / `/`
 * prefix removed. Used as an additional alias when matching plugin
 * commands. Returns null if the first token is empty, contains `<>` (a
 * placeholder), or has no alphanumeric characters.
 */
function extractCommandAlias(command: string): string | null {
  const value = String(command || "")
    .trim()
    .replace(/^[#/]+/, "");
  if (!value) {
    return null;
  }

  const firstToken = value.split(/\s+/)[0];
  if (!firstToken || /[<>]/.test(firstToken)) {
    return null;
  }

  if (!/[a-z0-9]/i.test(firstToken)) {
    return null;
  }

  const normalized = normalizeForMatch(firstToken);
  if (!normalized || STOPWORDS.has(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Build a sorted list of `HelpRenderableEntry` from a help map. The
 * rendered entries are the source of truth for both keyword scoring
 * (in this file) and the HTML renderer's overview list. Exported so
 * `html-generator.ts` can reuse it instead of duplicating the logic.
 *
 * `viewerRole` filters out commands above the requester's permission
 * level so the overview/detail views don't show commands they can't
 * invoke. Defaults to `"master"` so callers that don't yet know the
 * viewer (e.g. AI skill listings) keep the full registry.
 */
export function getRenderableEntries(
  helpMap: Map<string, PluginHelp>,
  viewerRole: CommandRole = "master",
): HelpRenderableEntry[] {
  return Array.from(helpMap.entries())
    .map(([pluginName, help]) => {
      const title = String(help.title || pluginName).trim() || pluginName;
      const description = String(help.description || "").trim();
      const allCommands = Array.isArray(help.commands) ? help.commands : [];
      const commands = allCommands.filter((command) =>
        canInvokeCommand(
          viewerRole,
          command.role as CommandRole | undefined,
        ),
      );
      const normalizedPluginName = normalizeForMatch(pluginName);
      const normalizedTitle = normalizeForMatch(title);

      const keys = new Set<string>();
      if (normalizedPluginName) {
        keys.add(normalizedPluginName);
      }
      if (normalizedTitle) {
        keys.add(normalizedTitle);
      }

      for (const token of extractMatchTokens(title)) {
        keys.add(token);
      }

      const commandAliases = allCommands
        .map((command) => extractCommandAlias(command.cmd))
        .filter((value): value is string => Boolean(value));
      for (const alias of commandAliases) {
        keys.add(alias);
      }

      return {
        pluginName,
        title,
        description,
        commands,
        normalizedPluginName,
        normalizedTitle,
        matchKeys: keys,
      };
    })
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName, "zh-Hans-CN"));
}

/**
 * Score a query against an entry. Higher = better match. Used to break
 * ties between fuzzy candidates.
 *
 * - 58: prefix overlap (e.g. "wea" matches "weather")
 * - 46: title containment
 * - 34: substring overlap
 * - 0: no match
 */
function scoreKeywordMatch(
  query: string,
  entry: HelpRenderableEntry,
): number {
  let score = 0;

  if (
    entry.normalizedTitle.includes(query) ||
    query.includes(entry.normalizedTitle)
  ) {
    score = Math.max(
      score,
      46 - Math.abs(entry.normalizedTitle.length - query.length),
    );
  }

  for (const key of entry.matchKeys) {
    if (key.startsWith(query) || query.startsWith(key)) {
      score = Math.max(score, 58 - Math.abs(key.length - query.length));
      continue;
    }

    if (key.includes(query) || query.includes(key)) {
      score = Math.max(score, 34 - Math.abs(key.length - query.length));
    }
  }

  return Math.max(0, score);
}

/**
 * Extract every possible plugin keyword from a chat message. Each
 * candidate carries a `strictUnknown` flag: strict patterns (e.g. the
 * user clearly asked about a specific plugin) should produce a
 * "no plugin found" reply, loose patterns should silently fall through.
 */
function extractHelpKeywordCandidates(
  text: string,
): HelpKeywordCandidate[] {
  const source = text.trim();
  const candidates: HelpKeywordCandidate[] = [];

  const addCandidate = (value: string, strictUnknown: boolean) => {
    const keyword = sanitizeKeyword(value);
    if (!keyword) {
      return;
    }
    if (
      !candidates.some(
        (candidate) =>
          candidate.keyword === keyword &&
          candidate.strictUnknown === strictUnknown,
      )
    ) {
      candidates.push({ keyword, strictUnknown });
    }
  };

  const helpPrefixSeparated = source.match(
    /^[#/]?\s*(?:help|帮助)(?:\s+|[:：])\s*(.+)$/i,
  );
  if (helpPrefixSeparated?.[1]) {
    addCandidate(helpPrefixSeparated[1], true);
  }

  const helpPrefixMerged = source.match(
    /^[#/]?\s*(?:help|帮助)([a-z0-9\u4e00-\u9fa5]+)$/i,
  );
  if (helpPrefixMerged?.[1]) {
    addCandidate(helpPrefixMerged[1], false);
  }

  if (/^[#/]/.test(source)) {
    return candidates;
  }

  const helpSuffixSeparated = source.match(/^(.+?)\s+(?:help|帮助)\s*$/i);
  if (helpSuffixSeparated?.[1]) {
    addCandidate(helpSuffixSeparated[1], true);
  }

  const helpSuffixMerged = source.match(
    /^([a-z0-9\u4e00-\u9fa5]+)(?:help|帮助)\s*$/i,
  );
  if (helpSuffixMerged?.[1]) {
    addCandidate(helpSuffixMerged[1], false);
  }

  const menuPrefix = source.match(
    /^菜单\s*[:：]?\s*([a-z0-9\u4e00-\u9fa5]+)$/i,
  );
  if (menuPrefix?.[1]) {
    addCandidate(menuPrefix[1], false);
  }

  const menuSuffix = source.match(/^([a-z0-9\u4e00-\u9fa5]+)\s*菜单\s*$/i);
  if (menuSuffix?.[1]) {
    addCandidate(menuSuffix[1], false);
  }

  return candidates;
}

/**
 * Resolve a keyword to a plugin help entry. Tries exact, then
 * start-substring, then fuzzy. Returns null if the query is too short
 * (< 2 chars), matches a stop-word, or has ambiguous results.
 */
export function findPluginHelpByKeyword(
  helpMap: Map<string, PluginHelp>,
  keyword: string,
): { pluginName: string; help: PluginHelp } | null {
  const normalizedQuery = normalizeForMatch(sanitizeKeyword(keyword));
  if (!normalizedQuery || STOPWORDS.has(normalizedQuery)) {
    return null;
  }

  const entries = getRenderableEntries(helpMap);
  if (entries.length === 0) {
    return null;
  }

  const directPlugin = entries.find(
    (entry) => entry.normalizedPluginName === normalizedQuery,
  );
  if (directPlugin) {
    return {
      pluginName: directPlugin.pluginName,
      help: helpMap.get(directPlugin.pluginName)!,
    };
  }

  const exactMatches = entries.filter((entry) =>
    entry.matchKeys.has(normalizedQuery),
  );
  if (exactMatches.length === 1) {
    return {
      pluginName: exactMatches[0].pluginName,
      help: helpMap.get(exactMatches[0].pluginName)!,
    };
  }

  if (normalizedQuery.length < 2) {
    return null;
  }

  const fuzzyMatches = entries
    .map((entry) => ({
      entry,
      score: scoreKeywordMatch(normalizedQuery, entry),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (fuzzyMatches.length === 0) {
    return null;
  }

  if (
    fuzzyMatches.length > 1 &&
    fuzzyMatches[0].score === fuzzyMatches[1].score
  ) {
    return null;
  }

  const resolved = fuzzyMatches[0].entry;
  return {
    pluginName: resolved.pluginName,
    help: helpMap.get(resolved.pluginName)!,
  };
}

/**
 * Parse a chat message into a help image action.
 *
 * Returns:
 * - `{ type: "overview" }` for plain `#help` / `帮助` / `菜单`
 * - `{ type: "detail", ... }` when a plugin name is recognized
 * - `{ type: "unknown", keyword }` when the user clearly named a plugin
 *   but we couldn't find it (only for "strict" patterns like "X 帮助")
 * - `{ type: "none" }` for anything else
 */
export function resolveHelpImageIntent(
  text: string,
  helpMap: Map<string, PluginHelp>,
): HelpImageIntent {
  const source = String(text || "").trim();
  if (!source) {
    return { type: "none" };
  }

  if (
    /^[#/]/.test(source) &&
    !/^[#/]\s*(?:help|帮助|菜单)/i.test(source)
  ) {
    return { type: "none" };
  }

  if (/^[#/]?\s*(?:help|帮助|菜单)\s*$/i.test(source)) {
    return { type: "overview" };
  }

  const candidates = extractHelpKeywordCandidates(source);
  if (candidates.length === 0) {
    return { type: "none" };
  }

  for (const candidate of candidates) {
    const resolved = findPluginHelpByKeyword(helpMap, candidate.keyword);
    if (resolved) {
      return {
        type: "detail",
        pluginName: resolved.pluginName,
        pluginHelp: resolved.help,
      };
    }
  }

  const strictCandidate = candidates.find(
    (candidate) => candidate.strictUnknown,
  );
  if (!strictCandidate) {
    return { type: "none" };
  }

  const fallback = sanitizeKeyword(strictCandidate.keyword);
  if (!fallback) {
    return { type: "none" };
  }

  return {
    type: "unknown",
    keyword: fallback,
  };
}
