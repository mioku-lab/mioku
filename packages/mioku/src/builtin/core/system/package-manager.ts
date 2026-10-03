import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { rootLogger as logger } from "../../../logger";
import { compareVersions, pickHighestVersion } from "../../../internal/version";

const NPM_REGISTRY = "https://registry.npmjs.org";
const OFFICIAL_REGISTRY_URL =
  "https://raw.githubusercontent.com/mioku-lab/mioku/main/official-registry.json";
const PLUGIN_PREFIX = "mioku-plugin-";
const SERVICE_PREFIX = "mioku-service-";
const FRAMEWORK_NAME = "mioku";

export type PackageType = "plugin" | "service" | "framework";

export interface InstalledPackage {
  name: string;
  type: PackageType;
  shortName: string;
  version: string;
  path: string;
}

export interface UpdateAvailable {
  name: string;
  type: PackageType;
  shortName: string;
  current: string;
  latest: string;
}

export interface MarketItem {
  name: string;
  npm: string;
  type: PackageType;
  description: string;
  latest: string;
  installed: boolean;
  installedVersion: string;
  hasUpdate: boolean;
  tags: string[];
  official: boolean;
  homepage: string;
  repo: string;
}

interface OfficialRegistryEntry {
  npm?: string;
  builtin?: boolean;
}

interface OfficialRegistry {
  plugins?: Record<string, OfficialRegistryEntry>;
  services?: Record<string, OfficialRegistryEntry>;
  hidden?: Partial<Record<"plugins" | "services" | "adapters", string[]>>;
}

interface NpmSearchObject {
  package: {
    name: string;
    description?: string;
    version?: string;
    keywords?: string[];
    date?: string;
    links?: {
      npm?: string;
      repository?: string;
      homepage?: string;
    };
  };
  searchScore?: number;
  score?: { final?: number };
}

export interface BunRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function projectRoot(): string {
  return process.cwd();
}

function detectType(name: string): PackageType | null {
  if (name === FRAMEWORK_NAME) return "framework";
  if (name.startsWith(PLUGIN_PREFIX)) return "plugin";
  if (name.startsWith(SERVICE_PREFIX)) return "service";
  return null;
}

function shortNameOf(name: string): string {
  if (name === FRAMEWORK_NAME) return FRAMEWORK_NAME;
  if (name.startsWith(PLUGIN_PREFIX)) return name.slice(PLUGIN_PREFIX.length);
  if (name.startsWith(SERVICE_PREFIX)) return name.slice(SERVICE_PREFIX.length);
  return name;
}

export async function runBun(
  args: string[],
  cwd?: string,
): Promise<BunRunResult> {
  const runCwd = cwd ?? projectRoot();
  logger.info(`[core] 执行: bun ${args.join(" ")}  (cwd: ${runCwd})`);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bun", args, {
      cwd: runCwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      logger.error(`[core] bun 进程异常: ${err}`);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        logger.info(`[core] bun 完成 (耗时 ${elapsed}s)`);
      } else {
        logger.error(
          `[core] bun 退出码 ${exitCode} (耗时 ${elapsed}s)\n${stderr || stdout}`,
        );
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

function readPackageJson(dir: string): any | null {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

export function getInstalledVersion(pkgName: string): string {
  const pkg = readPackageJson(
    path.join(projectRoot(), "node_modules", pkgName),
  );
  return String(pkg?.version || "0.0.0");
}

/** 项目 package.json 声明的 mioku 依赖，不含被 hoist 上来的传递依赖 */
export function listDeclaredPackages(): InstalledPackage[] {
  const pkg = readPackageJson(projectRoot());
  if (!pkg) return [];
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  const result: InstalledPackage[] = [];
  for (const name of Object.keys(deps)) {
    const type = detectType(name);
    if (!type) continue;
    const fullPath = path.join(projectRoot(), "node_modules", name);
    const installed = readPackageJson(fullPath);
    if (!installed) continue;
    result.push({
      name,
      type,
      shortName: shortNameOf(name),
      version: String(installed.version || "0.0.0"),
      path: fullPath,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** .update all 的作用范围：声明的插件与服务，不含框架与传递依赖 */
export function listManagedPackages(): InstalledPackage[] {
  return listDeclaredPackages().filter((pkg) => pkg.type !== "framework");
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "mioku-core" },
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

interface NpmPackageMeta {
  latest: string;
  /** registry 上的 latest 标签原值 */
  distTag: string;
  /** latest 标签指向了版本列表里不存在的版本 */
  staleTag: boolean;
  description: string;
  keywords: string[];
  homepage: string;
  repository: string;
  readme: string;
  license: string;
}

async function fetchNpmMeta(pkgName: string): Promise<NpmPackageMeta | null> {
  try {
    const data = await fetchJson(
      `${NPM_REGISTRY}/${encodeURIComponent(pkgName)}`,
    );
    const versions = Object.keys(data?.versions ?? {});
    const distTag = String(data?.["dist-tags"]?.latest || "").trim();
    // 刚发布时 registry 可能先更新 latest 标签、后同步版本信息
    const staleTag = distTag !== "" && !versions.includes(distTag);
    const latest = staleTag
      ? (pickHighestVersion(versions) ?? distTag)
      : distTag || (pickHighestVersion(versions) ?? "");
    if (!latest) return null;
    if (staleTag) {
      logger.debug(
        `[core] ${pkgName} 的 latest 标签 ${distTag} 不存在，改用 ${latest}`,
      );
    }
    const version = data?.versions?.[latest] || {};
    const repository = version?.repository || data?.repository;
    let repoUrl = "";
    if (typeof repository === "string") repoUrl = repository;
    else if (repository?.url) repoUrl = repository.url;
    repoUrl = repoUrl.replace(/^git\+/, "").replace(/\.git$/, "");
    return {
      latest,
      distTag,
      staleTag,
      description: String(
        version?.description || data?.description || "",
      ).trim(),
      keywords: Array.isArray(version?.keywords) ? version.keywords : [],
      homepage: String(version?.homepage || data?.homepage || "").trim(),
      repository: repoUrl,
      readme: String(data?.readme || "").trim(),
      license: String(version?.license || data?.license || "").trim(),
    };
  } catch {
    return null;
  }
}

export async function checkUpdates(): Promise<UpdateAvailable[]> {
  const installed = listDeclaredPackages();
  const metas = await Promise.all(
    installed.map(async (pkg) => {
      const meta = await fetchNpmMeta(pkg.name);
      return { pkg, meta };
    }),
  );

  const updates: UpdateAvailable[] = [];
  for (const { pkg, meta } of metas) {
    if (!meta || !meta.latest) continue;
    if (compareVersions(meta.latest, pkg.version) <= 0) continue;
    updates.push({
      name: pkg.name,
      type: pkg.type,
      shortName: pkg.shortName,
      current: pkg.version,
      latest: meta.latest,
    });
  }
  return updates;
}

export interface PackageUpdateOutcome {
  name: string;
  ok: boolean;
  before: string;
  after: string;
  changed: boolean;
  /** 失败原因，取 bun 输出里的错误行 */
  error?: string;
}

export interface UpdateReport {
  outcomes: PackageUpdateOutcome[];
  /** 仍停留在更新前版本的包 */
  failures: PackageUpdateOutcome[];
}

/** 取 bun 输出里最有用的一行：优先 error: 行，去掉颜色与前缀，超长截断 */
function errorSummary(text: string): string {
  const lines = String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = (
    lines.find((item) => /^error:/i.test(item)) ??
    lines[0] ??
    "更新失败"
  ).replace(/^error:\s*/i, "");
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function snapshotVersions(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    map.set(name, getInstalledVersion(name));
  }
  return map;
}

function outcomeOf(
  name: string,
  before: Map<string, string>,
  ok = true,
  error?: string,
): PackageUpdateOutcome {
  const prev = before.get(name) ?? "0.0.0";
  const after = getInstalledVersion(name);
  return { name, ok, before: prev, after, changed: prev !== after, error };
}

/** latest 标签不可解析时，改用 npm 上真实存在的最高版本 */
async function updateWithPinnedVersion(name: string): Promise<boolean> {
  const meta = await fetchNpmMeta(name);
  const target = meta?.latest ?? "";
  if (!target) return false;
  // 已是最新版本：标签损坏但无需更新
  if (compareVersions(target, getInstalledVersion(name)) <= 0) return true;
  logger.info(`[core] ${name} 的 latest 标签不可用，改用 ${target} 更新`);
  const result = await runBun(["update", `${name}@${target}`]);
  return result.code === 0;
}

async function updateOne(
  name: string,
  before: Map<string, string>,
): Promise<PackageUpdateOutcome> {
  const single = await runBun(["update", name, "--latest"]);
  if (single.code === 0) return outcomeOf(name, before);
  if (await updateWithPinnedVersion(name)) return outcomeOf(name, before);
  return outcomeOf(
    name,
    before,
    false,
    errorSummary(single.stderr || single.stdout),
  );
}

export async function updatePackages(names: string[]): Promise<UpdateReport> {
  if (names.length === 0) {
    return { outcomes: [], failures: [] };
  }
  const before = snapshotVersions(names);
  const batch = await runBun(["update", ...names, "--latest"]);
  if (batch.code === 0) {
    return {
      outcomes: names.map((name) => outcomeOf(name, before)),
      failures: [],
    };
  }

  logger.warn(
    `[core] 批量更新失败，改为逐个更新: ${errorSummary(batch.stderr || batch.stdout)}`,
  );
  const outcomes: PackageUpdateOutcome[] = [];
  for (const name of names) {
    outcomes.push(await updateOne(name, before));
  }
  return {
    outcomes,
    failures: outcomes.filter((outcome) => !outcome.ok),
  };
}

function appendToMiokuPlugins(pkgName: string): boolean {
  if (!pkgName.startsWith(PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(PLUGIN_PREFIX.length);
  const packageJsonPath = path.join(projectRoot(), "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const mioku = pkg.mioku ?? {};
  const plugins = Array.isArray(mioku.plugins) ? [...mioku.plugins] : [];
  if (plugins.includes(shortName)) return false;
  plugins.push(shortName);
  pkg.mioku = { ...mioku, plugins };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

function removeFromMiokuPlugins(pkgName: string): boolean {
  if (!pkgName.startsWith(PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(PLUGIN_PREFIX.length);
  const packageJsonPath = path.join(projectRoot(), "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const mioku = pkg.mioku ?? {};
  const plugins = Array.isArray(mioku.plugins) ? [...mioku.plugins] : [];
  if (!plugins.includes(shortName)) return false;
  pkg.mioku = {
    ...mioku,
    plugins: plugins.filter((name: string) => name !== shortName),
  };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

function normalizeTargetName(type: "plugin" | "service", name: string): string {
  const prefix = type === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export interface InstallResult {
  ok: boolean;
  packageName: string;
  enabled: boolean;
  output: string;
  error?: string;
}

export async function installPackage(
  type: "plugin" | "service",
  name: string,
): Promise<InstallResult> {
  const packageName = normalizeTargetName(type, name);
  logger.info(`[core] 开始安装 ${type} 包: ${packageName}`);
  const result = await runBun(["add", packageName]);
  if (result.code !== 0) {
    logger.error(
      `[core] 安装 ${packageName} 失败: ${result.stderr || result.stdout}`,
    );
    return {
      ok: false,
      packageName,
      enabled: false,
      output: result.stdout || result.stderr,
      error: result.stderr || result.stdout || "安装失败",
    };
  }
  let enabled = false;
  if (type === "plugin") {
    enabled = appendToMiokuPlugins(packageName);
  }
  const installedVersion = getInstalledVersion(packageName);
  logger.info(
    `[core] 安装成功 ${packageName}@${installedVersion}${enabled ? "（已启用）" : ""}`,
  );
  return {
    ok: true,
    packageName,
    enabled,
    output: result.stdout || result.stderr,
  };
}

export interface UninstallResult {
  ok: boolean;
  packageName: string;
  removedFromConfig: boolean;
  output: string;
  error?: string;
}

export async function uninstallPackage(
  type: "plugin" | "service",
  name: string,
): Promise<UninstallResult> {
  const packageName = normalizeTargetName(type, name);
  logger.info(`[core] 开始卸载 ${type} 包: ${packageName}`);
  const result = await runBun(["remove", packageName]);
  if (result.code !== 0) {
    logger.error(
      `[core] 卸载 ${packageName} 失败: ${result.stderr || result.stdout}`,
    );
    return {
      ok: false,
      packageName,
      removedFromConfig: false,
      output: result.stdout || result.stderr,
      error: result.stderr || result.stdout || "卸载失败",
    };
  }
  let removedFromConfig = false;
  if (type === "plugin") {
    removedFromConfig = removeFromMiokuPlugins(packageName);
  }
  logger.info(
    `[core] 卸载成功 ${packageName}${removedFromConfig ? "（已从配置移除）" : ""}`,
  );
  return {
    ok: true,
    packageName,
    removedFromConfig,
    output: result.stdout || result.stderr,
  };
}

export async function fetchOfficialRegistry(): Promise<OfficialRegistry> {
  return fetchJson(OFFICIAL_REGISTRY_URL);
}

async function searchNpmPackages(): Promise<NpmSearchObject[]> {
  const url = `${NPM_REGISTRY}/-/v1/search?text=mioku&size=250`;
  const data = (await fetchJson(url)) as { objects?: NpmSearchObject[] };
  return data.objects || [];
}

function extractKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "mioku");
}

function buildMarketItem(
  pkgName: string,
  meta: NpmPackageMeta | null,
  official: boolean,
): MarketItem {
  const type = detectType(pkgName) as "plugin" | "service";
  const installedVersion = getInstalledVersion(pkgName);
  const installed = installedVersion !== "0.0.0" && installedVersion !== "";
  const latest = String(meta?.latest || "");
  return {
    name: shortNameOf(pkgName),
    npm: pkgName,
    type,
    description: meta?.description || "暂无介绍",
    latest,
    installed,
    installedVersion: installed ? installedVersion : "",
    hasUpdate: installed && latest !== "" && latest !== installedVersion,
    tags: extractKeywords(meta?.keywords).slice(0, 4),
    official,
    homepage: meta?.homepage || "",
    repo: meta?.repository || "",
  };
}

export async function getMarketItems(
  type: "plugin" | "service",
): Promise<MarketItem[]> {
  const registry = await fetchOfficialRegistry();
  const registryKey = type === "plugin" ? "plugins" : "services";
  const officialEntries = registry[registryKey] || {};
  const officialNpmNames = new Set(
    Object.values(officialEntries)
      .map((entry) => String(entry?.npm || ""))
      .filter(Boolean),
  );
  const hiddenShorts = new Set(registry.hidden?.[registryKey] ?? []);

  const searchObjects = await searchNpmPackages().catch(
    () => [] as NpmSearchObject[],
  );
  const prefix = type === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;

  const candidateNames = new Set<string>();
  for (const obj of searchObjects) {
    const name = String(obj?.package?.name || "");
    if (name.startsWith(prefix)) candidateNames.add(name);
  }
  for (const name of officialNpmNames) {
    if (name.startsWith(prefix)) candidateNames.add(name);
  }
  // hidden 名单内的包不出现在市场
  for (const name of Array.from(candidateNames)) {
    if (hiddenShorts.has(name.slice(prefix.length)))
      candidateNames.delete(name);
  }

  const metas = await Promise.all(
    Array.from(candidateNames).map(async (pkgName) => {
      const meta = await fetchNpmMeta(pkgName);
      return { pkgName, meta, official: officialNpmNames.has(pkgName) };
    }),
  );

  const items = metas
    .filter((entry) => entry.meta !== null)
    .filter((entry) => (entry.meta?.keywords ?? []).includes("mioku"))
    .map((entry) => buildMarketItem(entry.pkgName, entry.meta, entry.official));

  return items.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.official !== b.official) return a.official ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
