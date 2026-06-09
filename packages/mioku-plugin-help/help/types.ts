/**
 * Public types for the help image flow.
 *
 * Kept in their own module so `intent.ts`, `info.ts`, `html-generator.ts`,
 * and consumers can all import from a single place without creating cycles.
 */

import type { PluginHelp } from "mioku";

/** Result of parsing a chat message into a help-image action. */
export type HelpImageIntent =
  | { type: "none" }
  | { type: "overview" }
  | { type: "detail"; pluginName: string; pluginHelp: PluginHelp }
  | { type: "unknown"; keyword: string };

/** Internal record used while ranking fuzzy keyword matches. */
export interface HelpRenderableEntry {
  pluginName: string;
  title: string;
  description: string;
  commands: PluginHelp["commands"];
  /** Lower-cased, alphanumeric-only form of `pluginName` for matching. */
  normalizedPluginName: string;
  /** Lower-cased, alphanumeric-only form of `title` for matching. */
  normalizedTitle: string;
  /** All normalized tokens we treat as equivalent to this entry. */
  matchKeys: Set<string>;
}

/** A candidate plugin keyword extracted from a chat message. */
export interface HelpKeywordCandidate {
  keyword: string;
  /**
   * `true` if the keyword came from a strict help prefix/suffix pattern
   * (e.g. "插件名 帮助"). A strict unknown should be surfaced to the user
   * as "没有找到插件 X 的帮助"; loose matches silently fall through.
   */
  strictUnknown: boolean;
}
