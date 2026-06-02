/**
 * Role badge palette and keyword stop-words.
 *
 * Both are referenced from multiple files in the help flow (intent
 * matching, HTML rendering), so we keep them in one place to avoid
 * divergent definitions.
 */

import type { CommandRole } from "mioku";

/** Per-role label + light/dark badge colors. */
export const ROLE_CONFIG: Record<
  CommandRole,
  {
    label: string;
    badgeBgLight: string;
    badgeBorderLight: string;
    badgeTextLight: string;
    badgeBgDark: string;
    badgeBorderDark: string;
    badgeTextDark: string;
  }
> = {
  master: {
    label: "主人",
    badgeBgLight: "rgba(245, 158, 11, 0.14)",
    badgeBorderLight: "rgba(217, 119, 6, 0.24)",
    badgeTextLight: "#92400e",
    badgeBgDark: "rgba(245, 158, 11, 0.18)",
    badgeBorderDark: "rgba(251, 191, 36, 0.28)",
    badgeTextDark: "#fcd34d",
  },
  admin: {
    label: "管理",
    badgeBgLight: "rgba(239, 68, 68, 0.12)",
    badgeBorderLight: "rgba(220, 38, 38, 0.22)",
    badgeTextLight: "#b91c1c",
    badgeBgDark: "rgba(239, 68, 68, 0.16)",
    badgeBorderDark: "rgba(248, 113, 113, 0.22)",
    badgeTextDark: "#fca5a5",
  },
  owner: {
    label: "管理",
    badgeBgLight: "rgba(239, 68, 68, 0.12)",
    badgeBorderLight: "rgba(220, 38, 38, 0.22)",
    badgeTextLight: "#b91c1c",
    badgeBgDark: "rgba(239, 68, 68, 0.16)",
    badgeBorderDark: "rgba(248, 113, 113, 0.22)",
    badgeTextDark: "#fca5a5",
  },
  member: {
    label: "成员",
    badgeBgLight: "rgba(14, 165, 233, 0.12)",
    badgeBorderLight: "rgba(2, 132, 199, 0.2)",
    badgeTextLight: "#0369a1",
    badgeBgDark: "rgba(56, 189, 248, 0.16)",
    badgeBorderDark: "rgba(103, 232, 249, 0.22)",
    badgeTextDark: "#67e8f9",
  },
};

/**
 * Words that should never be treated as a plugin name, even if the user
 * typed something like "help 帮助". Used by both intent matching and
 * alias extraction.
 */
export const STOPWORDS = new Set(["help", "帮助", "菜单"]);
