import { homedir } from "node:os";
import * as path from "node:path";
import type { SkillRoot, SkillRootKind } from "./types";

export interface SkillRootOptions {
  /** 机器人根目录，默认 `process.cwd()` */
  botRoot?: string;
  /** 用户主目录，默认 `os.homedir()` */
  home?: string;
  /** 额外扫描根，可写 `~/` 简写 */
  extraRoots?: string[];
}

interface SkillRootSpec {
  id: string;
  label: string;
  kind: SkillRootKind;
  scope: "project" | "user";
  segments: string[];
  rank: number;
}

/** 五个标准技能根，按 rank 升序；与 Claude Code / Codex / `npx skills add` 的目录约定一致 */
export const DEFAULT_SKILL_ROOT_SPECS: readonly SkillRootSpec[] = [
  {
    id: "project-agents",
    label: ".agents/skills",
    kind: "project-agents",
    scope: "project",
    segments: [".agents", "skills"],
    rank: 100,
  },
  {
    id: "project-claude",
    label: ".claude/skills",
    kind: "project-claude",
    scope: "project",
    segments: [".claude", "skills"],
    rank: 200,
  },
  {
    id: "user-agents",
    label: "~/.agents/skills",
    kind: "user-agents",
    scope: "user",
    segments: [".agents", "skills"],
    rank: 400,
  },
  {
    id: "user-claude",
    label: "~/.claude/skills",
    kind: "user-claude",
    scope: "user",
    segments: [".claude", "skills"],
    rank: 500,
  },
  {
    id: "user-codex",
    label: "~/.codex/skills",
    kind: "user-codex",
    scope: "user",
    segments: [".codex", "skills"],
    rank: 600,
  },
];

const CUSTOM_RANK = 300;

/** 展开开头的 `~/` */
export function expandHomePath(input: string, home = homedir()): string {
  const raw = String(input ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(home, raw.slice(2));
  }
  return raw;
}

function displayPath(target: string, home: string): string {
  const rel = path.relative(home, target);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return target;
}

/** 解析出当前机器上的技能根列表，自定义根排在项目根之后、用户根之前 */
export function resolveSkillRoots(options: SkillRootOptions = {}): SkillRoot[] {
  const botRoot = path.resolve(options.botRoot ?? process.cwd());
  const home = path.resolve(options.home ?? homedir());
  const roots: SkillRoot[] = [];

  for (const spec of DEFAULT_SKILL_ROOT_SPECS) {
    const base = spec.scope === "project" ? botRoot : home;
    roots.push({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      path: path.join(base, ...spec.segments),
      rank: spec.rank,
      writable: true,
    });
  }

  const extra = (options.extraRoots ?? [])
    .map((item) => expandHomePath(item, home))
    .filter(Boolean)
    .map((item) => path.resolve(item));
  extra.forEach((target, index) => {
    roots.push({
      id: `custom:${index + 1}`,
      label: displayPath(target, home),
      kind: "custom",
      path: target,
      // 同级靠数组顺序（sort 稳定）保持配置顺序
      rank: CUSTOM_RANK,
      writable: true,
    });
  });

  return roots.sort((a, b) => a.rank - b.rank);
}

export function findSkillRoot(
  roots: readonly SkillRoot[],
  id: string,
): SkillRoot | undefined {
  return roots.find((root) => root.id === id);
}

/** 判断路径是否落在某个根内，返回该根 */
export function rootOfPath(
  roots: readonly SkillRoot[],
  target: string,
): SkillRoot | undefined {
  const resolved = path.resolve(target);
  return roots.find((root) => {
    const rel = path.relative(root.path, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
