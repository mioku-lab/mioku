#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import mri from "mri";
import path from "node:path";
import os from "node:os";
import dedent from "dedent";
import consola from "consola";
import { version } from "../package.json";
import { readFileSync } from "node:fs";

const DEFAULT_PACKAGES = [
  "mioku",
  "mioku-plugin-boot",
  "mioku-plugin-help",
  "mioku-plugin-chat",
  "mioku-service-config",
  "mioku-service-ai",
  "mioku-service-screenshot",
  "mioku-service-help",
];

const PLUGIN_PREFIX = "mioku-plugin-";
const SERVICE_PREFIX = "mioku-service-";

const args = process.argv.slice(2);

function run(
  cmd: string,
  args: string[] = [],
  options: Parameters<typeof execFileSync>[2] = {},
) {
  // On Windows, ensure PATH includes common locations for npm/node
  if (process.platform === "win32") {
    const npmPath = process.env.PATH || "";
    const extraPaths = [
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
      `${process.env.APPDATA || ""}\\npm`,
    ].filter(Boolean).join(";");
    options.env = {
      ...process.env,
      PATH: extraPaths ? `${extraPaths};${npmPath}` : npmPath,
    };
  }
  return execFileSync(cmd, args, {
    stdio: "inherit",
    ...options,
  });
}

interface CliOptions {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number;
  token?: string;
  prefix?: string;
  owners?: string;
  admins?: string;
  help?: boolean;
  version?: boolean;
  "use-npm-mirror"?: boolean;
}

function commandExists(cmd: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [cmd], { stdio: "ignore" });
    } else {
      execFileSync("which", [cmd], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function ensurePackageManager() {
  if (commandExists("bun")) return;

  console.log("安装 bun...");

  run("npm", ["install", "-g", "bun"]);
}

function getAddCommand(packages: string[]): [string, string[]] {
  return ["bun", ["add", ...packages]];
}

function normalizePackageName(input: string): string {
  if (input.startsWith(PLUGIN_PREFIX) || input.startsWith(SERVICE_PREFIX)) {
    return input;
  }
  if (input.startsWith("mioku-")) {
    // 已经是完整名称，如 mioku-plugin-xxx
    return input;
  }
  // 默认当作 plugin 处理
  return `${PLUGIN_PREFIX}${input}`;
}

function detectType(name: string): "plugin" | "service" | "unknown" {
  if (name.startsWith(PLUGIN_PREFIX)) return "plugin";
  if (name.startsWith(SERVICE_PREFIX)) return "service";
  return "unknown";
}

async function getPackageManager(): Promise<string> {
  return "bun";
}

async function installWebUIDist(projectPath: string) {
  consola.info("正在安装 WebUI...");

  try {
    run("bun", ["add", "mioku-service-webui"], {
      cwd: projectPath,
    });

    consola.success("mioku-service-webui 安装成功");
  } catch (err) {
    consola.error("安装 mioku-service-webui 失败");
    console.error(err);
    return;
  }

  const nodeModulesWebui = path.join(
    projectPath,
    "node_modules",
    "mioku-service-webui",
  );

  const targetDist = path.join(nodeModulesWebui, "dist");

  consola.info(`WebUI dist 目录: ${targetDist}`);

  try {
    consola.info("正在获取 WebUI Release 信息...");

    const releaseRes = await fetch(
      "https://api.github.com/repos/mioku-lab/mioku-webui/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "mioku-cli",
        },
      },
    );

    if (!releaseRes.ok) {
      consola.error(`GitHub API 请求失败: ${releaseRes.status}`);
      return;
    }

    const release = await releaseRes.json();

    consola.success(`获取 Release 成功: ${release.tag_name}`);

    const assets = release.assets || [];

    const distAsset = assets.find(
      (a: any) =>
        a.name.includes("dist") ||
        a.name.endsWith(".zip"),
    );

    if (!distAsset) {
      consola.error("未找到 dist zip 资源");
      console.log(
        "可用资源:",
        assets.map((a: any) => a.name),
      );
      return;
    }

    consola.info(`下载资源: ${distAsset.name}`);

    const zipRes = await fetch(distAsset.browser_download_url, {
      headers: {
        "User-Agent": "mioku-cli",
      },
    });

    if (!zipRes.ok) {
      consola.error(`下载失败: ${zipRes.status}`);
      return;
    }

    const buffer = Buffer.from(await zipRes.arrayBuffer());

    const tmpZip = path.join(
      os.tmpdir(),
      `mioku-webui-${Date.now()}.zip`,
    );

    fs.writeFileSync(tmpZip, buffer);

    consola.success(`ZIP 下载完成: ${tmpZip}`);

    const tmpUnpack = path.join(
      os.tmpdir(),
      `mioku-webui-unpack-${Date.now()}`,
    );

    fs.mkdirSync(tmpUnpack, {
      recursive: true,
    });

    if (!commandExists("unzip")) {
      consola.error("系统未安装 unzip");
      consola.info("Debian/Ubuntu: apt install unzip");
      return;
    }

    consola.info("正在解压 WebUI...");

    run("unzip", ["-oq", tmpZip, "-d", tmpUnpack]);

    consola.success("解压完成");

    const sourceDir = findDistSourceDir(tmpUnpack);

    if (!sourceDir) {
      consola.error("未找到 dist/index.html");
      consola.info(`解压目录: ${tmpUnpack}`);
      return;
    }

    consola.success(`找到 dist: ${sourceDir}`);

    fs.mkdirSync(targetDist, {
      recursive: true,
    });

    fs.cpSync(sourceDir, targetDist, {
      recursive: true,
      force: true,
    });

    consola.success("WebUI dist 安装成功");

    fs.rmSync(tmpZip, {
      force: true,
    });

    fs.rmSync(tmpUnpack, {
      recursive: true,
      force: true,
    });

    consola.success("临时文件清理完成");
  } catch (err) {
    consola.error("安装 WebUI dist 失败");
    console.error(err);
  }
}

function findDistSourceDir(unpackDir: string): string | null {
  const directCandidates = [path.join(unpackDir, "dist"), unpackDir];
  for (const candidate of directCandidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  const children = fs.readdirSync(unpackDir);
  for (const child of children) {
    const childPath = path.join(unpackDir, child);
    if (fs.statSync(childPath).isDirectory()) {
      const subCandidate = path.join(childPath, "dist");
      if (fs.existsSync(path.join(subCandidate, "index.html"))) {
        return subCandidate;
      }
    }
  }
  return null;
}

function execAdd(packages: string[], cwd?: string) {
  const [cmd, args] = getAddCommand(packages);

  console.log(`执行: ${cmd} ${args.join(" ")}`);

  run(cmd, args, {
    cwd,
  });
}

async function installPackage(name: string, cwd?: string) {
  const normalized = normalizePackageName(name);
  const type = detectType(normalized);
  if (type === "unknown") {
    consola.error(`无法识别的包类型: ${name}`);
    return false;
  }
  try {
    execAdd([normalized], cwd);
    consola.success(`已安装 ${normalized}`);
    return true;
  } catch {
    consola.error(`安装失败: ${normalized}`);
    return false;
  }
}

async function updatePackage(name: string, cwd?: string) {
  try {
    console.log(`执行: bun update ${name}`);

    run("bun", ["update", name], {
      cwd,
    });
    consola.success(`已更新 ${name}`);
    return true;
  } catch {
    consola.error(`更新失败: ${name}`);
    return false;
  }
}

async function checkUpdates(
  packages: string[],
  cwd?: string,
) {
  try {
    const output = execFileSync(
      "bun",
      ["pm", "outdated", "--json"],
      {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      },
    );
    if (!output.trim()) {
      consola.info("所有依赖已是最新版本");
      return [];
    }
    const outdated = JSON.parse(output);
    const updates: string[] = [];
    for (const pkg of packages) {
      if (outdated[pkg]) {
        updates.push(
          `${pkg}: ${outdated[pkg].current} → ${outdated[pkg].latest}`,
        );
      }
    }
    return updates;
  } catch {
    return [];
  }
}

async function getInstalledPackages(cwd: string): Promise<string[]> {
  try {
    const pkgPath = path.join(cwd, "package.json");
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    return Object.keys(deps).filter((k) => k.startsWith("mioku-"));
  } catch {
    return [];
  }
}

(async () => {
  const cli = mri<CliOptions>(args, {
    alias: {
      v: "version",
      h: "help",
    },
  });

  const helpInfo = dedent(`
  mioku 命令行工具 v${version}

  用法: mioku <命令> [选项]

  命令:
    install plugin <名称>   安装插件，自动补全 mioku-plugin- 前缀
    install service <名称>  安装服务，自动补全 mioku-service- 前缀
    update [包名|self|all]   更新插件或服务
                            update          - 检查可用更新
                            update all      - 更新所有 mioku- 包
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

  const [cmd, ...cmdArgs] = args;

  switch (cmd) {
    case "install": {
      ensurePackageManager();
      const cwd = process.cwd();
      const type = cmdArgs[0];
      const name = cmdArgs[1];

      if (!type || !name) {
        consola.error("请指定类型和名称: mioku install plugin <名称> 或 mioku install service <名称>");
        console.log(helpInfo);
        process.exit(1);
      }

      if (type !== "plugin" && type !== "service") {
        consola.error(`无效的类型 "${type}"，请使用 plugin 或 service`);
        console.log(helpInfo);
        process.exit(1);
      }

      const prefix = type === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
      const normalized = `${prefix}${name}`;
      const success = await installPackage(normalized, cwd);
      process.exit(success ? 0 : 1);
    }

    case "update": {
      ensurePackageManager();
      const cwd = process.cwd();

      if (!cmdArgs.length || cmdArgs[0] === "check") {
        // 检查更新
        const packages = await getInstalledPackages(cwd);
        const updates = await checkUpdates(packages, cwd);
        if (updates.length === 0) {
          consola.info("所有 mioku 依赖已是最新版本");
        } else {
          console.log("\n可用更新:");
          updates.forEach((u) => consola.warn(`  ${u}`));
          console.log("\n运行 npx mioku update all 更新所有包");
        }
        process.exit(0);
      }

      const target = cmdArgs[0];

      if (target === "all") {
        // 更新所有 mioku- 包
        const packages = await getInstalledPackages(cwd);
        if (packages.length === 0) {
          consola.info("未找到 mioku 相关依赖");
          process.exit(0);
        }
        for (const pkg of packages) {
          await updatePackage(pkg, cwd);
        }
        process.exit(0);
      }

      if (target === "self") {
        await updatePackage("mioku", cwd);
        process.exit(0);
      }

      if (target === "plugin" || target === "service") {
        // update plugin/service [name]
        const name = cmdArgs[1];
        if (!name) {
          // 更新所有指定类型的包
          const packages = await getInstalledPackages(cwd);
          const prefix = target === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
          const filtered = packages.filter((p) => p.startsWith(prefix));
          if (filtered.length === 0) {
            consola.info(`未找到 ${prefix}* 相关依赖`);
            process.exit(0);
          }
          for (const pkg of filtered) {
            await updatePackage(pkg, cwd);
          }
        } else {
          const prefix = target === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
          const normalized = name.startsWith(prefix)
            ? name
            : `${prefix}${name}`;
          await updatePackage(normalized, cwd);
        }
        process.exit(0);
      }

      // update xxx - 更新指定包，自动识别前缀
      const packages = await getInstalledPackages(cwd);
      if (packages.includes(target)) {
        await updatePackage(target, cwd);
      } else {
        const normalized = normalizePackageName(target);
        await updatePackage(normalized, cwd);
      }
      process.exit(0);
    }

    default: {
      // 原始交互式项目创建
      const cli = mri<CliOptions>(args, {
        alias: {
          v: "version",
          h: "help",
        },
      });

      switch (true) {
        case cli.version:
          console.log(`v${version}`);
          process.exit(0);
          // fall through

        case cli.help:
          console.log(helpInfo);
          process.exit(0);
          // fall through

        default:
          break;
      }

      const name = await input("请输入项目名称", {
        default: "mioku-bot",
        placeholder: "mioku-bot",
        required: true,
      });

      const owners = await input("请输入主人 QQ (最高权限，英文逗号分隔，必填)", {
        placeholder: "请输入",
        default: "",
        required: true,
      });

      const host = await input("请输入 NapCat WS 主机", {
        default: "localhost",
        placeholder: "localhost",
        required: true,
      });

      const port = parseInt(
        await input("请输入 NapCat WS 端口", {
          default: "3001",
          placeholder: "3001",
          required: true,
        }),
      );

      const token = await input("请输入 NapCat WS Token（如无则留空）", {
        placeholder: "请输入",
      });

      const installWebui = await confirm("是否安装 WebUI？(建议安装)", {
        initial: true,
      });

      ensurePackageManager();

      const pkgJson = dedent(`
      {
        "name": "${name}",
        "private": true,
        "type": "module",
        "dependencies": {},
        "mioki": {
          "prefix": "#",
          "owners": [${String(owners)
            .split(",")
            .map((o) => o.trim())
            .join(", ")}],
          "admins": [],
          "plugins": ["boot", "help", "chat", "demo"],
          "log_level": "info",
          "online_push": false,
          "error_push": false,
          "napcat": [
            {
              "protocol": "ws",
              "port": ${port},
              "host": "${host}",
              "token": "${token}"
            }
          ]
        },
        "scripts": {
          "start": "bun run app.ts",
          "dev": "bun run --watch app.ts"
        }
      }
`);

      const pluginCode = dedent(`
      import { definePlugin } from 'mioku'

      export default definePlugin({
        name: 'demo',
        version: '${version}',
        async setup(ctx) {
          ctx.logger.info('Demo 插件已加载')

          ctx.handle('message', async (e) => {
            if (e.raw_message === 'hello') {
              e.reply('world', true)
            }
          })

          return () => {
            ctx.logger.info('Demo 插件已卸载')
          }
        },
      })
`);

      const fileTree: Record<string, any> = {
        "app.ts":
          "import { start } from 'mioku'\n\nstart({ cwd: import.meta.dirname }).then()\n",
        "package.json": pkgJson,
        plugins: { demo: { "index.ts": pluginCode } },
        config: {},
        data: {},
      };

      await createNewProject(name, fileTree);

      if (installWebui) {
        await installWebUIDist(path.join(process.cwd(), name));
      }

      console.log("\n接下来的操作：");
      console.log("  cd", name);
      console.log("  bun run start");
    }
  }
})();

async function createNewProject(
  name: string,
  fileTree: Record<string, any>,
) {
  const projectName = name;
  const projectPath = withRoot(`./${projectName}`);

  if (fs.existsSync(projectPath)) {
    const overwrite = await confirm(`项目 ${projectName} 已存在，是否覆盖？`);

    if (!overwrite) {
      gracefullyExit();
    }

    if (projectPath === process.cwd()) {
      if (fs.readdirSync(projectPath).length !== 0) {
        const confirmOver = await confirm(
          "项目路径与当前路径相同，将删除当前目录下所有内容再创建，是否继续？",
        );
        if (!confirmOver) {
          gracefullyExit();
        }
      }
    }

    fs.rmSync(projectPath, { recursive: true });
  }

  fs.mkdirSync(projectPath);

  makeFileTree(fileTree, projectPath);

  console.log(`项目 ${projectName} 创建成功！`);

  const [cmd, args] = getAddCommand(DEFAULT_PACKAGES);
  console.log(`正在安装 Mioku 依赖: ${cmd} ${args.join(" ")}`);
  run(cmd, args, {
    cwd: projectPath,
  });
}

function gracefullyExit() {
  console.log("Bye!");
  process.exit(0);
}

function withRoot(_path: string) {
  return path.resolve(process.cwd(), _path);
}

type OmitTypeWithRequired<T> = Omit<T, "type" | "required"> & {
  required?: boolean;
};

async function confirm(
  message: string,
  options?: OmitTypeWithRequired<{ initial?: boolean }>,
) {
  return consola.prompt(message, {
    type: "confirm",
    cancel: "reject",
    ...options,
  });
}

async function input(
  message: string,
  options?: OmitTypeWithRequired<{ default?: string; placeholder?: string }>,
) {
  const result = await consola.prompt(message, {
    type: "text",
    cancel: "reject",
    ...options,
  });
  if (options?.required && !result) return input(message, options);
  return result;
}

function makeFileTree(
  fileTree: Record<
    string,
    string | Record<string, string | Record<string, string>>
  >,
  base: string,
) {
  for (const [name, content] of Object.entries(fileTree)) {
    if (typeof content === "object" && content !== null) {
      const subPath = `${base}/${name}`;
      if (!fs.existsSync(subPath)) {
        fs.mkdirSync(subPath, { recursive: true });
      }
      for (const [subName, subContent] of Object.entries(content)) {
        if (typeof subContent === "object") {
          makeFileTree(content as typeof fileTree, subPath);
        } else {
          fs.writeFileSync(`${subPath}/${subName}`, subContent);
        }
      }
    } else {
      const filePath = `${base}/${name}`;
      const dirname = path.dirname(filePath);
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true });
      }
      fs.writeFileSync(filePath, content);
    }
  }
}
