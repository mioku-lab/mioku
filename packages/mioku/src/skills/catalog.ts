import * as fsp from "node:fs/promises";
import {
  listSkillEntries,
  mergeSkillGroups,
  readSkillEntry,
  type SkillEntry,
} from "./discover";
import { parseSkillFile } from "./frontmatter";
import { resolveSkillRoots, type SkillRootOptions } from "./roots";
import type {
  SkillDefinition,
  SkillDiagnostic,
  SkillLogger,
  SkillRoot,
  SkillSummary,
} from "./types";

export interface SkillCatalogOptions extends SkillRootOptions {
  /** 直接指定根，忽略 botRoot/home/extraRoots */
  roots?: SkillRoot[];
  maxResourceFiles?: number;
  /** 两次全量扫描之间的最小间隔，毫秒；0 表示每次都扫 */
  rescanIntervalMs?: number;
  logger?: SkillLogger;
}

export interface SkillCatalog {
  roots(): SkillRoot[];
  /** 技能摘要列表；带 TTL 与 mtime 缓存 */
  snapshot(options?: { force?: boolean }): Promise<SkillSummary[]>;
  /** 按需读取正文，每次重新读盘；名字变化时返回 undefined 并让下次重扫 */
  load(name: string): Promise<SkillDefinition | undefined>;
  diagnostics(): SkillDiagnostic[];
  /** 清空全部缓存（安装 / 卸载 / 手工改盘后调用） */
  invalidate(): void;
}

interface CachedEntry {
  /** `${SKILL.md mtime}:${size}|${dir mtime}` */
  key: string;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

interface SnapshotState {
  at: number;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
  /** 错误集合指纹，用于避免重复告警 */
  errorSignature: string;
}

const DEFAULT_RESCAN_INTERVAL_MS = 2000;

async function statKey(target: string): Promise<string> {
  try {
    const stat = await fsp.stat(target);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/** 技能目录：扫描五个标准根，合并去重，按需读正文 */
export function createSkillCatalog(
  options: SkillCatalogOptions = {},
): SkillCatalog {
  const roots = [...(options.roots ?? resolveSkillRoots(options))].sort(
    (a, b) => a.rank - b.rank,
  );
  const ttl = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
  const discoverOptions = { maxResourceFiles: options.maxResourceFiles };
  const logger = options.logger;
  const entries = new Map<string, CachedEntry>();
  let state: SnapshotState | undefined;

  async function scanRoot(
    root: SkillRoot,
    found: readonly SkillEntry[],
  ): Promise<SkillSummary[]> {
    const group: SkillSummary[] = [];
    for (const entry of found) {
      const key = await entryStamp(entry);
      const cached = entries.get(entry.skillPath);
      if (cached && cached.key === key) {
        group.push(...cached.skills);
        continue;
      }
      const result = await readSkillEntry(root, entry, discoverOptions);
      entries.set(entry.skillPath, {
        key,
        skills: result.skills,
        diagnostics: result.diagnostics,
      });
      group.push(...result.skills);
    }
    return group;
  }

  async function entryStamp(entry: SkillEntry): Promise<string> {
    const [file, dir] = await Promise.all([
      statKey(entry.skillPath),
      statKey(entry.skillDir),
    ]);
    return `${file}|${dir}`;
  }

  function errorSignature(diagnostics: readonly SkillDiagnostic[]): string {
    return diagnostics
      .filter((item) => item.level === "error")
      .map((item) => `${item.path}:${item.message}`)
      .join("\n");
  }

  async function scan(): Promise<SnapshotState> {
    const diagnostics: SkillDiagnostic[] = [];
    const seen = new Set<string>();
    const groups: SkillSummary[][] = [];

    for (const root of roots) {
      const found = await listSkillEntries(root);
      for (const entry of found) seen.add(entry.skillPath);
      groups.push(await scanRoot(root, found));
    }

    for (const path of [...entries.keys()]) {
      if (!seen.has(path)) entries.delete(path);
    }
    for (const cached of entries.values()) {
      diagnostics.push(...cached.diagnostics);
    }

    return {
      at: Date.now(),
      skills: mergeSkillGroups(groups, diagnostics),
      diagnostics,
      errorSignature: errorSignature(diagnostics),
    };
  }

  async function snapshot(opts: { force?: boolean } = {}): Promise<
    SkillSummary[]
  > {
    if (!opts.force && state && Date.now() - state.at < ttl) {
      return state.skills;
    }
    const next = await scan();
    // 只在错误集合变化时报一次，避免每轮刷屏
    if (next.errorSignature && next.errorSignature !== state?.errorSignature) {
      const failed = next.diagnostics.filter((item) => item.level === "error");
      logger?.warn(`技能扫描有 ${failed.length} 个文件不可用：${failed[0]?.message ?? ""}`);
    }
    state = next;
    return state.skills;
  }

  return {
    roots: () => roots,

    snapshot,

    async load(name: string): Promise<SkillDefinition | undefined> {
      const skills = await snapshot();
      const summary = skills.find((item) => item.name === name);
      if (!summary) return undefined;

      let raw: string;
      try {
        raw = await fsp.readFile(summary.path, "utf-8");
      } catch {
        state = undefined;
        return undefined;
      }
      const parsed = parseSkillFile(summary.path, raw);
      // 磁盘上的 name 变了：视为过期选择，让下次重扫
      if (!parsed.skill || parsed.skill.name !== name) {
        state = undefined;
        entries.delete(summary.path);
        return undefined;
      }

      return {
        ...summary,
        name: parsed.skill.name,
        description: parsed.skill.description,
        invoke: parsed.skill.invoke,
        content: parsed.skill.content,
        allowedTools: parsed.skill.allowedTools,
        ...(parsed.skill.license ? { license: parsed.skill.license } : {}),
        ...(parsed.skill.compatibility
          ? { compatibility: parsed.skill.compatibility }
          : {}),
        ...(parsed.skill.metadata ? { metadata: parsed.skill.metadata } : {}),
      };
    },

    diagnostics: () => state?.diagnostics ?? [],

    invalidate(): void {
      entries.clear();
      state = undefined;
    },
  };
}
