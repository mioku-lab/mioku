/**
 * Build a plain-text version of the help registry.
 *
 * Used by AI skills: when the LLM is asked about a feature, the
 * `get_help_info` tool returns this text instead of an image, so the
 * model can read what's available without vision. Filtering goes through
 * the same entry builder as the image, so a member never gets admin-only
 * commands read back to them.
 */

import type { CommandRole, PluginHelp } from "mioku";
import { getRenderableEntries } from "./intent";
import { ROLE_CONFIG } from "./role-config";
import type { HelpAccessFilter } from "./types";

/**
 * Render a help registry as a single string the AI can read.
 * Format:
 *
 *   === Mioku Bot 帮助信息 ===
 *
 *   【插件标题】描述
 *     #cmd [角色] - 描述
 *     ...
 */
export function buildHelpInfoText(
  helpMap: Map<string, PluginHelp>,
  viewerRole: CommandRole = "master",
  accessFilter?: HelpAccessFilter,
): string {
  const info: string[] = ["=== Mioku Bot 帮助信息 ===\n"];

  for (const entry of getRenderableEntries(helpMap, viewerRole, accessFilter)) {
    info.push(`【${entry.title}】${entry.description}`);
    for (const cmd of entry.commands) {
      const roleLabel = cmd.role
        ? ` [${ROLE_CONFIG[cmd.role]?.label || cmd.role}]`
        : "";
      info.push(`  ${cmd.cmd}${roleLabel} - ${cmd.desc}`);
    }
    info.push("");
  }

  return info.join("\n");
}
