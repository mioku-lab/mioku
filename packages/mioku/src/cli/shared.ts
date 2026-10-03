import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import consola from "consola";
import dedent from "dedent";
import {
  clearCommandCache,
  commandExists,
  resolveCommand,
  runCommandInherit,
} from "../internal/exec";
import { pickHighestVersion } from "../internal/version";

export const PLUGIN_PREFIX = "mioku-plugin-";
export const SERVICE_PREFIX = "mioku-service-";
export const ADAPTER_PREFIX = "mioku-adapter-";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const OFFICIAL_REGISTRY_URL =
  "https://raw.githubusercontent.com/mioku-lab/mioku/main/official-registry.json";

export interface NpmPackageHit {
  name: string;
  description: string;
  version: string;
  keywords: string[];
}

async function searchNpm(query: string, size = 250): Promise<NpmPackageHit[]> {
  try {
    const url = `${NPM_REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "mioku-cli" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      objects?: Array<{
        package?: {
          name?: string;
          description?: string;
          version?: string;
          keywords?: string[];
        };
      }>;
    };
    const hits: NpmPackageHit[] = [];
    for (const obj of data.objects ?? []) {
      const pkg = obj.package ?? {};
      const name = String(pkg.name ?? "").trim();
      if (!name) continue;
      hits.push({
        name,
        description: String(pkg.description ?? "").trim(),
        version: String(pkg.version ?? "").trim(),
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
      });
    }
    return hits;
  } catch {
    return [];
  }
}

export async function searchMiokuPackages(
  prefix: string,
): Promise<NpmPackageHit[]> {
  const [broad, targeted] = await Promise.all([
    searchNpm("mioku"),
    searchNpm(prefix.replace(/-$/, "")),
  ]);
  const seen = new Set<string>();
  const hits: NpmPackageHit[] = [];
  for (const hit of [...broad, ...targeted]) {
    if (!hit.name.startsWith(prefix)) continue;
    if (!hit.keywords.includes("mioku")) continue;
    if (seen.has(hit.name)) continue;
    seen.add(hit.name);
    hits.push(hit);
  }
  return hits.sort((a, b) => a.name.localeCompare(b.name));
}

export interface OfficialRegistryEntry {
  npm?: string;
  builtin?: boolean;
}

export interface OfficialRegistry {
  plugins?: Record<string, OfficialRegistryEntry>;
  services?: Record<string, OfficialRegistryEntry>;
  adapters?: Record<string, OfficialRegistryEntry>;
  /** 市场隐藏名单：各类别下的包短名，不出现在引导与市场里 */
  hidden?: Partial<Record<"plugin" | "service" | "adapter", string[]>>;
}

export type MarketPackageType = "plugin" | "service" | "adapter";

/** 取官方注册表中某类别需要隐藏的包短名 */
export function hiddenShortNames(
  registry: OfficialRegistry | null,
  type: MarketPackageType,
): Set<string> {
  return new Set(registry?.hidden?.[type] ?? []);
}

export async function fetchOfficialRegistry(): Promise<OfficialRegistry | null> {
  try {
    const res = await fetch(OFFICIAL_REGISTRY_URL, {
      headers: { Accept: "application/json", "User-Agent": "mioku-cli" },
    });
    if (!res.ok) return null;
    return (await res.json()) as OfficialRegistry;
  } catch {
    return null;
  }
}

export interface NpmPackageMeta {
  version: string;
  description: string;
  keywords: string[];
  mioku?: unknown;
}

export async function fetchNpmPackageMeta(
  packageName: string,
): Promise<NpmPackageMeta | null> {
  try {
    const res = await fetch(
      `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`,
      {
        headers: { Accept: "application/json", "User-Agent": "mioku-cli" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const distTag = String(data?.["dist-tags"]?.latest || "").trim();
    const versions = Object.keys(data?.versions ?? {});
    // 刚发布时 registry 可能先更新 latest 标签、后同步版本信息
    const latest =
      distTag && versions.includes(distTag)
        ? distTag
        : (pickHighestVersion(versions) ?? distTag);
    const version = latest ? (data?.versions?.[latest] ?? {}) : {};
    return {
      version: latest,
      description: String(version?.description || "").trim(),
      keywords: Array.isArray(version?.keywords)
        ? version.keywords.map(String)
        : [],
      mioku: version?.mioku,
    };
  } catch {
    return null;
  }
}

export function declaredServicesOf(meta: NpmPackageMeta | null): string[] {
  const mioku = meta?.mioku;
  if (Array.isArray(mioku)) {
    return mioku.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
  }
  if (mioku && typeof mioku === "object") {
    const services = (mioku as { services?: unknown }).services;
    if (Array.isArray(services)) {
      return services.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
    }
  }
  return [];
}

export async function resolveRequiredServices(
  pluginNames: readonly string[],
): Promise<string[]> {
  const registry = await fetchOfficialRegistry();
  const serviceMap = new Map<string, string>();
  if (registry) {
    for (const [short, entry] of Object.entries(registry.services ?? {})) {
      if (entry?.npm) serviceMap.set(short, entry.npm);
    }
  }

  const required = new Set<string>();
  for (const pluginName of pluginNames) {
    const meta = await fetchNpmPackageMeta(pluginName);
    for (const short of declaredServicesOf(meta)) {
      const npm = serviceMap.get(short) ?? `${SERVICE_PREFIX}${short}`;
      if (serviceMap.has(short)) {
        required.add(npm);
        continue;
      }
      const check = await fetchNpmPackageMeta(npm);
      if (check && check.keywords.includes("mioku")) {
        required.add(npm);
      } else {
        consola.warn(
          `${pluginName} 声明了服务 "${short}"，但未找到对应的 mioku 服务包，已跳过`,
        );
      }
    }
  }
  return Array.from(required);
}

export async function multiSelect(
  message: string,
  items: Array<{ label: string; value: string }>,
  initial: string[] = [],
  options: { required?: boolean } = {},
): Promise<string[]> {
  if (items.length === 0) return [];
  const result = await consola.prompt(message, {
    type: "multiselect",
    options: items,
    initial,
    cancel: "reject",
    required: options.required ?? false,
  });
  return (result as Array<string | { value: string }>).map((item) =>
    typeof item === "string" ? item : item.value,
  );
}

/** 单选框，取消时抛出（调用方负责兜底） */
export async function selectOne<T extends string>(
  message: string,
  items: Array<{ label: string; value: T }>,
): Promise<T> {
  const result = await consola.prompt(message, {
    type: "select",
    options: items,
    cancel: "reject",
  });
  return result as T;
}

export function runAdapterCli(name: string, cwd: string): void {
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".cmd", ".ps1", ".bat"] : [""];
  for (const ext of exts) {
    const binPath = path.join(
      cwd,
      "node_modules",
      ".bin",
      `mioku-adapter-${name}${ext}`,
    );
    if (fs.existsSync(binPath)) {
      const realPath = (() => {
        try {
          return fs.realpathSync(binPath);
        } catch {
          return binPath;
        }
      })();
      run(realPath, [], { cwd });
      return;
    }
  }
  run("bunx", [`mioku-adapter-${name}`], { cwd });
}

export function shortNameOfPackage(pkgName: string): string {
  for (const prefix of [PLUGIN_PREFIX, SERVICE_PREFIX, ADAPTER_PREFIX]) {
    if (pkgName.startsWith(prefix)) return pkgName.slice(prefix.length);
  }
  return pkgName;
}

export function run(
  cmd: string,
  args: string[] = [],
  options: { cwd?: string } = {},
): void {
  runCommandInherit(cmd, args, options);
}

export async function rmrf(dir: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const code = err?.code;
      if (
        code === "EPERM" ||
        code === "EBUSY" ||
        code === "ENOTEMPTY" ||
        code === "ENOENT"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
      } else {
        throw err;
      }
    }
  }
}

export function hasCommand(cmd: string): boolean {
  return commandExists(cmd);
}

function findNpmPath(): string | null {
  const resolved = resolveCommand("npm");
  if (resolved) return resolved;
  if (process.platform !== "win32") return null;

  const fallbacks = [
    path.join(process.env.ProgramFiles || "", "nodejs", "npm.cmd"),
    path.join(process.env["ProgramFiles(x86)"] || "", "nodejs", "npm.cmd"),
    path.join(process.env.APPDATA || "", "npm", "npm.cmd"),
  ];

  return fallbacks.find((candidate) => resolveCommand(candidate)) ?? null;
}

function installBunViaOfficialScript(): void {
  console.log("安装 bun...");
  if (process.platform === "win32") {
    const ps =
      process.env.SystemRoot &&
      path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
    const psExe = ps && resolveCommand(ps) ? ps : "powershell";
    run(psExe, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm bun.sh/install.ps1 | iex",
    ]);
  } else {
    run("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"]);
  }
  clearCommandCache();
}

export function ensurePackageManager(): void {
  if (hasCommand("bun")) return;
  try {
    installBunViaOfficialScript();
  } catch (err) {
    const npmPath = findNpmPath();
    if (!npmPath) {
      consola.error("未找到 npm，请确保 Node.js 已安装并包含 npm");
      consola.error(
        '自动安装 bun 失败，请手动执行：\n  macOS / Linux: curl -fsSL https://bun.sh/install | bash\n  Windows: powershell -c "irm bun.sh/install.ps1 | iex"',
      );
      throw err;
    }
    consola.warn("官方安装脚本失败，回退到 npm 全局安装 bun ...");
    run(npmPath, ["install", "-g", "bun"]);
    clearCommandCache();
  }
  if (!hasCommand("bun")) {
    const home = os.homedir();
    const candidates =
      process.platform === "win32"
        ? [
            path.join(home, ".bun", "bin", "bun.exe"),
            path.join(process.env.APPDATA || "", "npm", "bun.cmd"),
            path.join(
              process.env.APPDATA || "",
              "npm",
              "node_modules",
              ".bin",
              "bun.cmd",
            ),
          ]
        : [
            path.join(home, ".bun", "bin", "bun"),
            "/usr/local/bin/bun",
            "/opt/homebrew/bin/bun",
          ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          consola.warn(
            `检测到 bun 已安装在 ${c}。请把该目录加入 PATH 后重新运行本命令。`,
          );
          break;
        }
      } catch {
        // 忽略
      }
    }
    consola.error(
      "bun 安装后仍无法在 PATH 中找到，请重启终端或将 bun 的安装目录加入 PATH 后重试",
    );
    process.exit(1);
  }
}

export function getAddCommand(packages: string[]): [string, string[]] {
  return ["bun", ["add", ...packages]];
}

export function normalizePackageName(input: string): string {
  if (input.startsWith(PLUGIN_PREFIX) || input.startsWith(SERVICE_PREFIX)) {
    return input;
  }
  if (input.startsWith("mioku-")) return input;
  return `${PLUGIN_PREFIX}${input}`;
}

export function detectType(name: string): "plugin" | "service" | "unknown" {
  if (name.startsWith(PLUGIN_PREFIX)) return "plugin";
  if (name.startsWith(SERVICE_PREFIX)) return "service";
  return "unknown";
}

export function execAdd(packages: string[], cwd?: string): void {
  const [cmd, args] = getAddCommand(packages);
  console.log(`执行: ${cmd} ${args.join(" ")}`);
  run(cmd, args, { cwd });
}

export function appendToMiokuPlugins(cwd: string, pkgName: string): boolean {
  if (!pkgName.startsWith(PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(PLUGIN_PREFIX.length);

  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const mioku = pkg.mioku ?? {};
  const plugins = Array.isArray(mioku.plugins) ? [...mioku.plugins] : [];
  if (plugins.includes(shortName)) return false;

  plugins.push(shortName);
  pkg.mioku = { ...mioku, plugins };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

export async function getInstalledPackages(cwd: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, "package.json"), "utf-8"),
    );
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps).filter(
      (k) => k === "mioku" || k.startsWith("mioku-"),
    );
  } catch {
    return [];
  }
}

/** 读取已安装包的版本，未安装返回 null */
export function installedVersionOf(
  cwd: string,
  pkgName: string,
): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, "node_modules", pkgName, "package.json"), "utf-8"),
    );
    return String(pkg.version || "") || null;
  } catch {
    return null;
  }
}

export function withRoot(p: string): string {
  return path.resolve(process.cwd(), p);
}

export async function fetchNpmKeywords(
  packageName: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(
      `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`,
      {
        headers: { Accept: "application/json", "User-Agent": "mioku-cli" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const latestVersion = String(data?.["dist-tags"]?.latest || "").trim();
    const keywords = latestVersion
      ? data?.versions?.[latestVersion]?.keywords
      : data?.keywords;
    return Array.isArray(keywords) ? keywords.map(String) : [];
  } catch {
    return null;
  }
}

export function gracefullyExit(): void {
  console.log("Bye!");
  process.exit(0);
}

export function makeFileTree(
  fileTree: Record<string, string | Record<string, unknown>>,
  base: string,
): void {
  for (const [name, content] of Object.entries(fileTree)) {
    if (typeof content === "object" && content !== null) {
      const subPath = path.join(base, name);
      if (!fs.existsSync(subPath)) fs.mkdirSync(subPath, { recursive: true });
      for (const [subName, subContent] of Object.entries(content)) {
        if (typeof subContent === "object") {
          makeFileTree(
            subContent as Record<string, string | Record<string, unknown>>,
            path.join(subPath, subName),
          );
        } else {
          fs.writeFileSync(path.join(subPath, subName), subContent as string);
        }
      }
    } else {
      const filePath = path.join(base, name);
      const dirname = path.dirname(filePath);
      if (!fs.existsSync(dirname)) fs.mkdirSync(dirname, { recursive: true });
      fs.writeFileSync(filePath, content as string);
    }
  }
}

export function buildHelpInfo(version: string): string {
  return dedent(`
  mioku 命令行工具 v${version}

  用法: mioku <命令> [选项]

  命令:
    install [类型] [名称]   安装包；不带参数时进入交互选择
                            install              - 选择安装 mioku 框架 / 插件 / 服务 / 适配器
                            install plugin <名称>  安装插件，自动补全 mioku-plugin- 前缀
                            install service <名称> 安装服务，自动补全 mioku-service- 前缀
                            install adapter <名称> 安装适配器并运行配置向导
    update [包名|self|all]   更新插件或服务
                            update          - 检查可用更新（含 mioku 框架）并选择更新
                            update all      - 更新所有 mioku 包（含框架）
                            update self     - 更新 mioku 框架
                            update xxx      - 更新指定包

  选项:
    -h, --help              显示帮助信息
    -v, --version           显示版本号
    --name <name>           指定项目/文件夹名称，默认 mioku-bot
    --protocol <protocol>   指定 NapCat 协议，默认 ws
    --host <host>           指定 NapCat 主机，默认 localhost
    --port <port>           指定 NapCat 端口，默认 3001
    --token <token>         指定 NapCat 连接 Token，默认空
    --prefix <prefix>       指定命令前缀，默认 #
    --owners <owners>       指定主人 QQ，英文逗号分隔，必填
    --admins <admins>       指定管理员 QQ，英文逗号分隔，可空
    --use-npm-mirror        使用 npm 镜像源加速依赖安装，默认否
  `);
}

type OmitTypeWithRequired<T> = Omit<T, "type" | "required"> & {
  required?: boolean;
};

export async function confirm(
  message: string,
  options?: OmitTypeWithRequired<{ initial?: boolean }>,
): Promise<boolean> {
  return consola.prompt(message, {
    type: "confirm",
    cancel: "reject",
    ...options,
  });
}

export async function input(
  message: string,
  options?: OmitTypeWithRequired<{ default?: string; placeholder?: string }>,
): Promise<string> {
  const result = await consola.prompt(message, {
    type: "text",
    cancel: "reject",
    ...options,
  });
  if (options?.required && !result) return input(message, options);
  return result;
}
