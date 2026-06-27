import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { logger } from "mioki";

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

export async function runBun(args: string[], cwd?: string): Promise<BunRunResult> {
  const runCwd = cwd ?? projectRoot();
  logger.info(`[boot] 执行: bun ${args.join(" ")}  (cwd: ${runCwd})`);
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
      logger.error(`[boot] bun 进程异常: ${err}`);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        logger.info(`[boot] bun 完成 (耗时 ${elapsed}s)`);
      } else {
        logger.error(
          `[boot] bun 退出码 ${exitCode} (耗时 ${elapsed}s)\n${stderr || stdout}`,
        );
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

export async function runBunOrThrow(args: string[], cwd?: string): Promise<string> {
  const result = await runBun(args, cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `bun ${args.join(" ")} 失败`);
  }
  return result.stdout;
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
  const pkg = readPackageJson(path.join(projectRoot(), "node_modules", pkgName));
  return String(pkg?.version || "0.0.0");
}

export function listInstalledPackages(): InstalledPackage[] {
  const modulesPath = path.join(projectRoot(), "node_modules");
  const result: InstalledPackage[] = [];
  if (!fs.existsSync(modulesPath)) return result;

  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    const type = detectType(entry.name);
    if (!type) continue;
    const fullPath = path.join(modulesPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const pkg = readPackageJson(fullPath);
    result.push({
      name: entry.name,
      type,
      shortName: shortNameOf(entry.name),
      version: String(pkg?.version || "0.0.0"),
      path: fullPath,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "mioku-boot" },
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

interface NpmPackageMeta {
  latest: string;
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
    const latest = String(data?.["dist-tags"]?.latest || "").trim();
    const version = latest ? data?.versions?.[latest] || {} : {};
    const repository = version?.repository || data?.repository;
    let repoUrl = "";
    if (typeof repository === "string") repoUrl = repository;
    else if (repository?.url) repoUrl = repository.url;
    repoUrl = repoUrl.replace(/^git\+/, "").replace(/\.git$/, "");
    return {
      latest,
      description: String(version?.description || data?.description || "").trim(),
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
  const installed = listInstalledPackages();
  const metas = await Promise.all(
    installed.map(async (pkg) => {
      const meta = await fetchNpmMeta(pkg.name);
      return { pkg, meta };
    }),
  );

  const updates: UpdateAvailable[] = [];
  for (const { pkg, meta } of metas) {
    if (!meta || !meta.latest) continue;
    if (meta.latest === pkg.version) continue;
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

export interface UpdatedPackageResult {
  name: string;
  before: string;
  after: string;
  changed: boolean;
}

function snapshotVersions(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    map.set(name, getInstalledVersion(name));
  }
  return map;
}

export async function updatePackages(names: string[]): Promise<BunRunResult> {
  if (names.length === 0) return { code: 0, stdout: "", stderr: "" };
  return runBun(["update", ...names, "--latest"]);
}

export async function updateAllManaged(): Promise<{
  result: BunRunResult;
  names: string[];
}> {
  const managed = listInstalledPackages()
    .filter((pkg) => pkg.type !== "framework")
    .map((pkg) => pkg.name);
  if (managed.length === 0) {
    return { result: { code: 0, stdout: "", stderr: "" }, names: [] };
  }
  return { result: await updatePackages(managed), names: managed };
}

export function diffVersions(
  names: string[],
  before: Map<string, string>,
): UpdatedPackageResult[] {
  return names.map((name) => {
    const after = getInstalledVersion(name);
    const prev = before.get(name) || "0.0.0";
    return { name, before: prev, after, changed: prev !== after };
  });
}

export function snapshotAll(names: string[]): Map<string, string> {
  return snapshotVersions(names);
}

function appendToMiokiPlugins(pkgName: string): boolean {
  if (!pkgName.startsWith(PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(PLUGIN_PREFIX.length);
  const packageJsonPath = path.join(projectRoot(), "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const mioki = pkg.mioki ?? {};
  const plugins = Array.isArray(mioki.plugins) ? [...mioki.plugins] : [];
  if (plugins.includes(shortName)) return false;
  plugins.push(shortName);
  pkg.mioki = { ...mioki, plugins };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

function removeFromMiokiPlugins(pkgName: string): boolean {
  if (!pkgName.startsWith(PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(PLUGIN_PREFIX.length);
  const packageJsonPath = path.join(projectRoot(), "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const mioki = pkg.mioki ?? {};
  const plugins = Array.isArray(mioki.plugins) ? [...mioki.plugins] : [];
  if (!plugins.includes(shortName)) return false;
  pkg.mioki = {
    ...mioki,
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
  logger.info(`[boot] 开始安装 ${type} 包: ${packageName}`);
  const result = await runBun(["add", packageName]);
  if (result.code !== 0) {
    logger.error(`[boot] 安装 ${packageName} 失败: ${result.stderr || result.stdout}`);
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
    enabled = appendToMiokiPlugins(packageName);
  }
  const installedVersion = getInstalledVersion(packageName);
  logger.info(
    `[boot] 安装成功 ${packageName}@${installedVersion}${enabled ? "（已启用）" : ""}`,
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
  logger.info(`[boot] 开始卸载 ${type} 包: ${packageName}`);
  const result = await runBun(["remove", packageName]);
  if (result.code !== 0) {
    logger.error(`[boot] 卸载 ${packageName} 失败: ${result.stderr || result.stdout}`);
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
    removedFromConfig = removeFromMiokiPlugins(packageName);
  }
  logger.info(
    `[boot] 卸载成功 ${packageName}${removedFromConfig ? "（已从配置移除）" : ""}`,
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
  const installed =
    installedVersion !== "0.0.0" && installedVersion !== "";
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
  const officialEntries =
    type === "plugin" ? registry.plugins || {} : registry.services || {};
  const officialNpmNames = new Set(
    Object.values(officialEntries)
      .map((entry) => String(entry?.npm || ""))
      .filter(Boolean),
  );

  const searchObjects = await searchNpmPackages().catch(() => [] as NpmSearchObject[]);
  const prefix = type === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;

  const candidateNames = new Set<string>();
  for (const obj of searchObjects) {
    const name = String(obj?.package?.name || "");
    if (name.startsWith(prefix)) candidateNames.add(name);
  }
  for (const name of officialNpmNames) {
    if (name.startsWith(prefix)) candidateNames.add(name);
  }

  const metas = await Promise.all(
    Array.from(candidateNames).map(async (pkgName) => {
      const meta = await fetchNpmMeta(pkgName);
      return { pkgName, meta, official: officialNpmNames.has(pkgName) };
    }),
  );

  const items = metas
    .filter((entry) => entry.meta !== null)
    .map((entry) =>
      buildMarketItem(entry.pkgName, entry.meta, entry.official),
    );

  return items.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.official !== b.official) return a.official ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
