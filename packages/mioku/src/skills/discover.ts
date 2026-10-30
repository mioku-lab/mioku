import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseSkillFile } from "./frontmatter";
import {
  SKILL_FILE_NAME,
  type SkillDiagnostic,
  type SkillRoot,
  type SkillSummary,
} from "./types";

export interface DiscoverOptions {
  /** 单个技能的附加文件上限 */
  maxResourceFiles?: number;
  /** 附加文件的相对深度上限 */
  maxResourceDepth?: number;
}

export interface DiscoveryResult {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

/** 根下的一个技能候选，尚未读盘 */
export interface SkillEntry {
  /** 目录形态时是技能目录名，扁平形态时是文件名 */
  entryName: string;
  /** 技能根目录（扁平形态等于 root.path） */
  skillDir: string;
  /** 指令文件绝对路径 */
  skillPath: string;
}

const DEFAULT_MAX_RESOURCE_FILES = 200;
const DEFAULT_MAX_RESOURCE_DEPTH = 3;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldSkipName(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRS.has(name);
}

async function safeRealpath(target: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(target);
  } catch {
    return undefined;
  }
}

/** 软链接要跟随：`npx skills add` 与 `.claude/skills -> ../.agents/skills` 都是常见布局 */
async function entryKind(
  full: string,
  entry: import("node:fs").Dirent,
): Promise<"dir" | "file" | "none"> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return "none";
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
  } catch {
    // 断链
  }
  return "none";
}

/** 技能目录内的附加文件，深度受限、跳过隐藏与依赖目录 */
async function listResources(
  dir: string,
  maxFiles: number,
  maxDepth: number,
): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const current = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth + 1 <= maxDepth) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === SKILL_FILE_NAME) continue;
      found.push(toPosix(path.relative(dir, full)));
      if (found.length >= maxFiles) break;
    }
  }
  return found.sort();
}

/** 枚举一个根下的技能候选：`<name>/SKILL.md` 与 `<name>.md` 两种形态 */
export async function listSkillEntries(root: SkillRoot): Promise<SkillEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: SkillEntry[] = [];
  for (const entry of entries) {
    if (shouldSkipName(entry.name)) continue;
    const full = path.join(root.path, entry.name);
    const kind = await entryKind(full, entry);
    if (kind === "dir") {
      found.push({
        entryName: entry.name,
        skillDir: full,
        skillPath: path.join(full, SKILL_FILE_NAME),
      });
      continue;
    }
    if (kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
      found.push({
        entryName: entry.name,
        skillDir: root.path,
        skillPath: full,
      });
    }
  }
  return found;
}

/** 读盘并解析一个技能候选；缺文件、软链接断链、超大都返回空结果 */
export async function readSkillEntry(
  root: SkillRoot,
  entry: SkillEntry,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const maxResourceFiles = options.maxResourceFiles ?? DEFAULT_MAX_RESOURCE_FILES;
  const maxResourceDepth = options.maxResourceDepth ?? DEFAULT_MAX_RESOURCE_DEPTH;

  const realDir = await safeRealpath(entry.skillDir);
  if (!realDir) return { skills: [], diagnostics: [] };

  let raw: string;
  try {
    raw = await fsp.readFile(entry.skillPath, "utf-8");
  } catch {
    return { skills: [], diagnostics: [] };
  }
  if (Buffer.byteLength(raw, "utf-8") > MAX_SKILL_FILE_BYTES) {
    return {
      skills: [],
      diagnostics: [
        {
          level: "error",
          code: "READ_FAILED",
          message: `${SKILL_FILE_NAME} 超过 256KB，已忽略`,
          path: entry.skillPath,
        },
      ],
    };
  }

  const parsed = parseSkillFile(entry.skillPath, raw);
  const diagnostics = [...parsed.diagnostics];
  if (!parsed.skill) return { skills: [], diagnostics };

  const expected = entry.entryName.replace(/\.md$/i, "");
  if (entry.skillDir !== root.path && parsed.skill.name !== expected) {
    diagnostics.push({
      level: "warn",
      code: "NAME_MISMATCH",
      message: `frontmatter name "${parsed.skill.name}" 与目录名 "${expected}" 不一致`,
      path: entry.skillPath,
    });
  }

  const resources =
    entry.skillDir === root.path
      ? []
      : await listResources(realDir, maxResourceFiles, maxResourceDepth);

  return {
    skills: [
      {
        name: parsed.skill.name,
        description: parsed.skill.description,
        invoke: parsed.skill.invoke,
        rootId: root.id,
        dir: realDir,
        path: entry.skillPath,
        resources,
      },
    ],
    diagnostics,
  };
}

/**
 * 按 rank 合并各组结果；重名时先出现的（rank 小的）获胜，后来者记一条 warn。
 * `groups` 必须已按 rank 升序排列。
 */
export function mergeSkillGroups(
  groups: readonly SkillSummary[][],
  diagnostics: SkillDiagnostic[],
): SkillSummary[] {
  const winners = new Map<string, SkillSummary>();
  for (const group of groups) {
    for (const summary of group) {
      const existing = winners.get(summary.name);
      if (existing) {
        diagnostics.push({
          level: "warn",
          code: "NAME_DUPLICATE",
          message: `技能名 "${summary.name}" 已被 ${existing.rootId} 占用，${summary.rootId} 的这份被忽略`,
          path: summary.path,
        });
        continue;
      }
      winners.set(summary.name, summary);
    }
  }
  return [...winners.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫描一个技能根（无缓存） */
export async function discoverRoot(
  root: SkillRoot,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const skills: SkillSummary[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const entry of await listSkillEntries(root)) {
    const result = await readSkillEntry(root, entry, options);
    skills.push(...result.skills);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

/** 扫描全部根（无缓存）；技能重名时 rank 小的先赢 */
export async function discoverSkills(
  roots: readonly SkillRoot[],
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const diagnostics: SkillDiagnostic[] = [];
  const groups: SkillSummary[][] = [];
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    const result = await discoverRoot(root, options);
    diagnostics.push(...result.diagnostics);
    groups.push(result.skills);
  }
  return { skills: mergeSkillGroups(groups, diagnostics), diagnostics };
}
