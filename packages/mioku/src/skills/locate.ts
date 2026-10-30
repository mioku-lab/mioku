import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseSkillFile } from "./frontmatter";
import { SKILL_FILE_NAME, type SkillDiagnostic } from "./types";

export interface SkillLocation {
  /** frontmatter 里的 name；解析不可用时退回目录名 */
  name: string;
  description: string;
  /** 技能根目录绝对路径 */
  dir: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 技能目录内的文件数（有上限） */
  files: number;
  /** 该候选是否可以直接安装 */
  valid: boolean;
  diagnostics: SkillDiagnostic[];
}

export interface LocateOptions {
  /** 递归深度上限，默认 3 */
  maxDepth?: number;
  /** 候选数量上限，默认 50 */
  maxCandidates?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CANDIDATES = 50;
const FILE_COUNT_CAP = 500;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRS.has(name);
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (queue.length > 0 && total < FILE_COUNT_CAP) {
    const current = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      if (entry.isDirectory()) {
        if (current.depth + 1 <= 3) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile()) total += 1;
    }
  }
  return total;
}

async function describe(dir: string, skillPath: string): Promise<SkillLocation> {
  const fallbackName = path.basename(dir);
  const files = await countFiles(dir);
  let raw: string;
  try {
    raw = await fsp.readFile(skillPath, "utf-8");
  } catch {
    return {
      name: fallbackName,
      description: "",
      dir,
      path: skillPath,
      files,
      valid: false,
      diagnostics: [
        { level: "error", code: "READ_FAILED", message: "SKILL.md 无法读取", path: skillPath },
      ],
    };
  }

  const parsed = parseSkillFile(skillPath, raw);
  if (!parsed.skill) {
    return {
      name: fallbackName,
      description: "",
      dir,
      path: skillPath,
      files,
      valid: false,
      diagnostics: parsed.diagnostics,
    };
  }
  return {
    name: parsed.skill.name,
    description: parsed.skill.description,
    dir,
    path: skillPath,
    files,
    valid: true,
    diagnostics: parsed.diagnostics,
  };
}

/**
 * 在下载/解包出来的目录里定位技能：根目录有 SKILL.md 就用它，
 * 否则向下（深度受限）找所有含 SKILL.md 的目录，供安装时挑选。
 */
export async function locateSkillRoots(
  root: string,
  options: LocateOptions = {},
): Promise<SkillLocation[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const base = path.resolve(root);

  const rootSkill = path.join(base, SKILL_FILE_NAME);
  if (await isFile(rootSkill)) return [await describe(base, rootSkill)];

  const found: Array<{ dir: string; path: string }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }];
  while (queue.length > 0 && found.length < maxCandidates) {
    const current = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkip(entry.name)) continue;
      const child = path.join(current.dir, entry.name);
      const skillPath = path.join(child, SKILL_FILE_NAME);
      if (await isFile(skillPath)) {
        found.push({ dir: child, path: skillPath });
        if (found.length >= maxCandidates) break;
        continue;
      }
      if (current.depth + 1 < maxDepth) {
        queue.push({ dir: child, depth: current.depth + 1 });
      }
    }
  }

  const locations: SkillLocation[] = [];
  for (const item of found) locations.push(await describe(item.dir, item.path));
  return locations;
}
