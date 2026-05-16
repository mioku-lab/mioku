#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { cwd } from "node:process";
import { execSync } from "node:child_process";

const ROOT_DIR = cwd();
const DEFAULT_PM = process.env.MIOKU_PM || "bun";
const DEFAULT_WEBUI_SERVICE_REPO =
  "https://github.com/mioku-lab/mioku-service-webui.git";
const DEFAULT_WEBUI_REPO = "https://github.com/mioku-lab/mioku-webui.git";

let TMP_DIR = "";

function log(...args: unknown[]) {
  console.log("[mioku-install]", ...args);
}

function warn(...args: unknown[]) {
  console.warn("[mioku-install] WARN:", ...args);
}

function die(...args: unknown[]) {
  console.error("[mioku-install] ERROR:", ...args);
  process.exit(1);
}

function cleanup() {
  if (TMP_DIR && existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

process.on("exit", cleanup);

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function installUnzip(): void {
  if (commandExists("unzip")) return;

  const platform = process.platform;
  if (platform === "darwin") {
    if (commandExists("brew")) {
      execSync("brew install unzip", { stdio: "inherit" });
      return;
    }
    die("未找到 unzip，且未安装 brew，请先运行: brew install unzip");
  } else if (platform === "linux") {
    if (commandExists("apt")) {
      execSync("sudo apt install -y unzip", { stdio: "inherit" });
      return;
    }
    if (commandExists("yum")) {
      execSync("sudo yum install -y unzip", { stdio: "inherit" });
      return;
    }
    die("未找到 unzip，且未安装 apt/yum，请先运行: sudo apt install unzip");
  } else {
    die("未找到 unzip，请手动安装");
  }
}

function ensureTmpDir() {
  if (!TMP_DIR) {
    TMP_DIR = join(tmpdir(), `mioku-install-${Date.now()}`);
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function tmpdir(): string {
  return process.env.TEMP || process.env.TMP || "/tmp";
}

function detectPm(wanted?: string): string {
  if (wanted && commandExists(wanted)) {
    return wanted;
  }

  for (const pm of ["bun", "pnpm", "npm"]) {
    if (commandExists(pm)) {
      if (wanted) {
        warn(`未找到 ${wanted}，自动使用 ${pm}`);
      }
      return pm;
    }
  }

  die("未找到可用包管理器（bun/pnpm/npm）");
  return "bun";
}

function safeRepoName(repo: string): string {
  let clean = repo.split("?")[0]!.split("#")[0]!.replace(/\/$/, "");
  clean = clean
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "");
  clean = clean.replace(/\.git$/, "");
  clean = basename(clean);

  if (!clean) {
    die(`无法从仓库地址推断名称: ${repo}`);
  }

  return clean;
}

function normalizePluginName(name: string): string {
  if (name.startsWith("mioku-plugin-")) {
    return name.slice("mioku-plugin-".length);
  }
  return name;
}

function normalizeServiceName(name: string): string {
  if (name.startsWith("mioku-service-")) {
    return name.slice("mioku-service-".length);
  }
  return name;
}

function cloneOrPull(repoUrl: string, destDir: string) {
  if (!commandExists("git")) {
    die("未安装 git");
  }

  if (existsSync(join(destDir, ".git"))) {
    log(`检测到已有仓库，拉取更新: ${destDir}`);
    execSync("git pull --ff-only", { cwd: destDir, stdio: "inherit" });
    return;
  }

  if (existsSync(destDir)) {
    die(`目标目录已存在且不是 git 仓库: ${destDir}`);
  }

  mkdirSync(dirname(destDir), { recursive: true });
  log(`克隆仓库: ${repoUrl}`);

  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(`git clone "${repoUrl}" "${destDir}"`, { stdio: "inherit" });
      return;
    } catch (error) {
      if (i < maxRetries - 1) {
        warn(`克隆失败，${maxRetries - i - 1} 秒后重试...`);
        const start = Date.now();
        while (Date.now() - start < 1000) {
          /* busy wait */
        }
      } else {
        throw error;
      }
    }
  }
}

function installDeps(dir: string, pm: string) {
  log(`安装依赖: ${dir} (${pm})`);
  execSync(`${pm} install`, { cwd: dir, stdio: "inherit" });
}

function addPluginToConfig(pluginName: string) {
  ensureTmpDir();

  const packageJsonPath = join(ROOT_DIR, "package.json");
  const configPath = join(ROOT_DIR, "config", "mioku.json");

  const pkg = readJson<Record<string, unknown>>(packageJsonPath, {});
  if (!pkg.mioki || typeof pkg.mioki !== "object") pkg.mioki = {};
  const mioki = pkg.mioki as Record<string, unknown>;
  if (!mioki.plugins) mioki.plugins = [];
  const plugins = mioki.plugins as string[];
  if (!plugins.includes(pluginName)) plugins.push(pluginName);
  writeJson(packageJsonPath, pkg);

  const cfg = readJson<{ mioki?: Record<string, unknown> }>(configPath, {
    mioki: {},
  });
  if (!cfg.mioki || typeof cfg.mioki !== "object") cfg.mioki = {};
  const cfgMioki = cfg.mioki as Record<string, unknown>;
  if (!cfgMioki.plugins) cfgMioki.plugins = [];
  const cfgPlugins = cfgMioki.plugins as string[];
  if (!cfgPlugins.includes(pluginName)) cfgPlugins.push(pluginName);
  writeJson(configPath, cfg);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function downloadFile(url: string, output: string) {
  if (commandExists("curl")) {
    execSync(
      `curl -fsSL --retry 2 --connect-timeout 20 -o "${output}" "${url}"`,
      { stdio: "inherit" },
    );
    return;
  }

  if (commandExists("wget")) {
    execSync(`wget -q -O "${output}" "${url}"`, { stdio: "inherit" });
    return;
  }

  die("未找到下载工具（curl 或 wget）");
}

function downloadGitHubJson(url: string, output: string) {
  if (commandExists("curl")) {
    execSync(
      `curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: mioku-installer" -o "${output}" "${url}"`,
      { stdio: "inherit" },
    );
    return;
  }

  if (commandExists("wget")) {
    execSync(
      `wget -q --header="Accept: application/vnd.github+json" --header="User-Agent: mioku-installer" -O "${output}" "${url}"`,
      { stdio: "inherit" },
    );
    return;
  }

  die("未找到下载工具（curl 或 wget）");
}

function extractZip(zipFile: string, destDir: string) {
  mkdirSync(destDir, { recursive: true });

  installUnzip();

  if (commandExists("unzip")) {
    execSync(`unzip -oq "${zipFile}" -d "${destDir}"`, { stdio: "inherit" });
    return;
  }

  if (commandExists("bsdtar")) {
    execSync(`bsdtar -xf "${zipFile}" -C "${destDir}"`, { stdio: "inherit" });
    return;
  }

  if (commandExists("tar")) {
    try {
      execSync(`tar -xf "${zipFile}" -C "${destDir}"`, { stdio: "inherit" });
      return;
    } catch {
      // continue
    }
  }

  if (process.platform === "win32") {
    execSync(
      `powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force"`,
      { stdio: "inherit" },
    );
    return;
  }

  die("没有可用解压工具（unzip/bsdtar/tar）");
}

function resolveGitHubRepoPath(repoUrl: string): string {
  let clean = repoUrl
    .replace(/\.git$/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "");

  if (!clean.includes("/")) {
    die(`webui 仓库必须是 GitHub 仓库地址: ${repoUrl}`);
  }

  const parts = clean.split("/");
  return `${parts[0]}/${parts[1]}`;
}

function jsonFirstValue(key: string, file: string): string | null {
  try {
    const content = readFileSync(file, "utf-8");
    const match = content.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function findWebuiAssetUrl(jsonFile: string): string | null {
  try {
    const content = readFileSync(jsonFile, "utf-8");
    const matches = content.match(/"browser_download_url"\s*:\s*"([^"]+)"/g);

    if (!matches) return null;

    for (const match of matches) {
      const urlMatch = match.match(/"browser_download_url"\s*:\s*"([^"]+)"/);
      if (urlMatch) {
        const url = urlMatch[1]!;
        if (/dist.*\.zip$/i.test(url)) return url;
      }
    }

    for (const match of matches) {
      const urlMatch = match.match(/"browser_download_url"\s*:\s*"([^"]+)"/);
      if (urlMatch) {
        const url = urlMatch[1]!;
        if (/\.zip$/i.test(url)) return url;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function resolveDistSourceDir(unpackDir: string): string | null {
  if (existsSync(join(unpackDir, "index.html"))) {
    return unpackDir;
  }

  if (existsSync(join(unpackDir, "dist", "index.html"))) {
    return join(unpackDir, "dist");
  }

  function findIndexHtml(dir: string): string | null {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findIndexHtml(fullPath);
        if (found) return found;
      } else if (entry.name === "index.html") {
        return fullPath;
      }
    }
    return null;
  }

  const indexPath = findIndexHtml(unpackDir);
  return indexPath ? dirname(indexPath) : null;
}

function installPlugin(
  repoUrl: string,
  name: string | undefined,
  wantedPm: string | undefined,
) {
  const pm = detectPm(wantedPm);

  if (!name) {
    name = safeRepoName(repoUrl);
  }

  name = normalizePluginName(name);
  const target = join(ROOT_DIR, "plugins", name);
  cloneOrPull(repoUrl, target);
  installDeps(target, pm);
  addPluginToConfig(name);

  log(`插件安装完成: ${name}`);
}

function installService(
  repoUrl: string,
  name: string | undefined,
  wantedPm: string | undefined,
) {
  const pm = detectPm(wantedPm);

  if (!name) {
    name = safeRepoName(repoUrl);
  }

  name = normalizeServiceName(name);
  const target = join(ROOT_DIR, "src", "services", name);
  cloneOrPull(repoUrl, target);
  installDeps(target, pm);

  log(`服务安装完成: ${name}`);
}

function installWebui(
  serviceRepo: string,
  webuiRepo: string,
  releaseTag: string,
  wantedPm: string | undefined,
  skipService: boolean,
) {
  const pm = detectPm(wantedPm);

  const webuiServiceDir = join(ROOT_DIR, "src", "services", "webui");
  const distDir = join(webuiServiceDir, "dist");

  if (!skipService) {
    cloneOrPull(serviceRepo, webuiServiceDir);
    installDeps(webuiServiceDir, pm);
  } else {
    log("跳过 webui 服务安装");
    mkdirSync(webuiServiceDir, { recursive: true });
  }

  ensureTmpDir();
  const repoPath = resolveGitHubRepoPath(webuiRepo);

  const apiUrl =
    releaseTag === "latest"
      ? `https://api.github.com/repos/${repoPath}/releases/latest`
      : `https://api.github.com/repos/${repoPath}/releases/tags/${releaseTag}`;

  const releaseJson = join(TMP_DIR, "release.json");
  downloadGitHubJson(apiUrl, releaseJson);

  const tagName = jsonFirstValue("tag_name", releaseJson);
  if (!tagName) {
    die("未获取到 release 信息，请确认仓库和 tag 是否正确");
  }

  const assetUrl = findWebuiAssetUrl(releaseJson);
  if (!assetUrl) {
    die("release 未找到 zip 资产，请确认已上传 dist 压缩包");
  }

  const assetFile = join(TMP_DIR, "webui-dist.zip");
  const unpackDir = join(TMP_DIR, "unpack");

  log(`下载 webui dist: ${assetUrl}`);
  downloadFile(assetUrl as string, assetFile);

  log("解压 webui dist");
  extractZip(assetFile, unpackDir);

  const sourceDir = resolveDistSourceDir(unpackDir);
  if (!sourceDir) {
    die("解压后未找到可用 dist 内容（缺少 index.html）");
  }

  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
  mkdirSync(distDir, { recursive: true });

  copyDirRecursive(sourceDir as string, distDir);

  const version = (tagName as string).replace(/^v/, "");
  writeFileSync(join(distDir, ".webui-version"), version, "utf-8");
  writeFileSync(
    join(distDir, "webui-version.json"),
    `{"version":"${version}"}`,
    "utf-8",
  );

  log(`WebUI 安装完成: ${version}`);
  log(`服务目录: ${webuiServiceDir}`);
  log(`dist 目录: ${distDir}`);
}

function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

function usage() {
  console.log(`
用法:
  bun run mioku-install plugin <repo-url> [--name NAME] [--pm bun|pnpm|npm]
  bun run mioku-install service <repo-url> [--name NAME] [--pm bun|pnpm|npm]
  bun run mioku-install webui [--pm bun|pnpm|npm] [--service-repo URL] [--webui-repo URL] [--tag latest|vX.Y.Z] [--skip-service]
  bun run mioku-install help

示例:
  bun run mioku-install plugin https://github.com/you/your-plugin.git
  bun run mioku-install service https://github.com/you/your-service.git --pm pnpm
  bun run mioku-install webui
  bun run mioku-install webui --tag v1.4.0
`);
}

function parsePluginOrServiceArgs(mode: string, args: string[]) {
  let repoUrl = "";
  let name = "";
  let pm = DEFAULT_PM;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--name") {
      if (i + 1 >= args.length) die("--name 缺少参数");
      name = args[i + 1]!;
      i += 2;
    } else if (arg === "--pm") {
      if (i + 1 >= args.length) die("--pm 缺少参数");
      pm = args[i + 1]!;
      i += 2;
    } else if (arg.startsWith("-")) {
      die(`未知参数: ${arg}`);
    } else {
      if (!repoUrl) {
        repoUrl = arg;
        i++;
      } else {
        die(`多余参数: ${arg}`);
      }
    }
  }

  if (!repoUrl) {
    die(`${mode} 需要 repo-url`);
  }

  if (mode === "plugin") {
    installPlugin(repoUrl, name || undefined, pm);
  } else {
    installService(repoUrl, name || undefined, pm);
  }
}

function parseWebuiArgs(args: string[]) {
  let pm = DEFAULT_PM;
  let serviceRepo = DEFAULT_WEBUI_SERVICE_REPO;
  let webuiRepo = DEFAULT_WEBUI_REPO;
  let tag = "latest";
  let skipService = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--pm") {
      if (i + 1 >= args.length) die("--pm 缺少参数");
      pm = args[i + 1]!;
      i += 2;
    } else if (arg === "--service-repo") {
      if (i + 1 >= args.length) die("--service-repo 缺少参数");
      serviceRepo = args[i + 1]!;
      i += 2;
    } else if (arg === "--webui-repo") {
      if (i + 1 >= args.length) die("--webui-repo 缺少参数");
      webuiRepo = args[i + 1]!;
      i += 2;
    } else if (arg === "--tag") {
      if (i + 1 >= args.length) die("--tag 缺少参数");
      tag = args[i + 1]!;
      i += 2;
    } else if (arg === "--skip-service") {
      skipService = true;
      i++;
    } else if (arg.startsWith("-")) {
      die(`未知参数: ${arg}`);
    } else {
      die(`多余参数: ${arg}`);
    }
  }

  installWebui(serviceRepo, webuiRepo, tag, pm, skipService);
}

function main() {
  const cmd = process.argv[2] || "help";
  const args = process.argv.slice(3);

  switch (cmd) {
    case "plugin":
      parsePluginOrServiceArgs("plugin", args);
      break;
    case "service":
      parsePluginOrServiceArgs("service", args);
      break;
    case "webui":
      parseWebuiArgs(args);
      break;
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    default:
      die(`未知命令: ${cmd}`);
  }
}

main();
