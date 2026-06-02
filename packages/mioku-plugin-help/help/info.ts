/**
 * Build a plain-text version of the help registry.
 *
 * Used by AI skills: when the LLM is asked about a feature, the
 * `get_help_info` tool returns this text instead of an image, so the
 * model can read what's available without vision.
 */

import type { PluginHelp } from "mioku";
import { ROLE_CONFIG } from "./role-config";

/**
 * Render the entire help registry as a single string the AI can read.
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
): string {
  const info: string[] = ["=== Mioku Bot 帮助信息 ===\n"];

  for (const [pluginName, help] of helpMap) {
    info.push(`【${help.title || pluginName}】${help.description || ""}`);
    if (help.commands?.length) {
      for (const cmd of help.commands) {
        const roleLabel = cmd.role
          ? ` [${ROLE_CONFIG[cmd.role]?.label || cmd.role}]`
          : "";
        info.push(`  ${cmd.cmd}${roleLabel} - ${cmd.desc}`);
      }
    }
    info.push("");
  }

  return info.join("\n");
}
