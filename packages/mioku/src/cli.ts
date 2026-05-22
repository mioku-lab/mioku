#!/usr/bin/env node

import fs from "node:fs";
import { execSync } from "node:child_process";
import mri from "mri";
import path from "node:path";
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
    execSync(`command -v ${cmd} > /dev/null 2>&1`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensurePackageManager(pm: string) {
  if (commandExists(pm)) return pm;

  if (pm === "bun") {
    console.log("安装 bun...");
    execSync("npm install -g bun", { stdio: "inherit" });
    return "bun";
  }

  if (pm === "pnpm") {
    console.log("pnpm 未安装，正在安装...");
    execSync("npm install -g pnpm", { stdio: "inherit" });
    return "pnpm";
  }

  if (pm === "npm") {
    return "npm";
  }

  return pm;
}

function getAddCommand(pm: string, packages: string[]): string {
  const packageList = packages.join(" ");

  if (pm === "npm") {
    return `npm add ${packageList}`;
  }

  if (pm === "pnpm") {
    return `pnpm add ${packageList}`;
  }

  return `bun add ${packageList}`;
}

async function selectPackageManager(): Promise<string> {
  const choices = ["bun", "npm", "pnpm"];

  const result = await consola.prompt("选择包管理器 (默认 bun)", {
    type: "text",
    default: "bun",
  });

  const normalized = result.toString().trim().toLowerCase();
  if (choices.includes(normalized)) {
    return normalized;
  }
  return "bun";
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
  const choices = ["bun", "npm", "pnpm"];
  const result = await consola.prompt("选择包管理器 (默认 bun)", {
    type: "text",
    default: "bun",
  });
  const normalized = result.toString().trim().toLowerCase();
  if (choices.includes(normalized)) return normalized;
  return "bun";
}

function execAdd(pkgManager: string, packages: string[], cwd?: string) {
  const cmd = getAddCommand(pkgManager, packages);
  console.log(`执行: ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

async function installPackage(name: string, pkgManager: string, cwd?: string) {
  const normalized = normalizePackageName(name);
  const type = detectType(normalized);
  if (type === "unknown") {
    consola.error(`无法识别的包类型: ${name}`);
    return false;
  }
  try {
    execAdd(pkgManager, [normalized], cwd);
    consola.success(`已安装 ${normalized}`);
    return true;
  } catch {
    consola.error(`安装失败: ${normalized}`);
    return false;
  }
}

async function updatePackage(name: string, pkgManager: string, cwd?: string) {
  try {
    const cmd =
      pkgManager === "npm"
        ? `npm update ${name}`
        : pkgManager === "pnpm"
          ? `pnpm update ${name}`
          : `bun update ${name}`;
    console.log(`执行: ${cmd}`);
    execSync(cmd, { cwd, stdio: "inherit" });
    consola.success(`已更新 ${name}`);
    return true;
  } catch {
    consola.error(`更新失败: ${name}`);
    return false;
  }
}

async function checkUpdates(
  packages: string[],
  pkgManager: string,
  cwd?: string,
) {
  const cmd =
    pkgManager === "npm"
      ? `npm outdated --json`
      : pkgManager === "pnpm"
        ? `pnpm outdated --json`
        : `bun pm outdated --json`;

  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
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
    install <包名>        安装插件或服务
                          支持: mioku-plugin-xxx, mioku-service-xxx
                          自动补全前缀，可直接写 xxx
    update [包名|self|all] 更新插件或服务
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
      const pkgManager = await getPackageManager();
      const cwd = process.cwd();
      if (!cmdArgs.length) {
        consola.error("请指定要安装的包名");
        console.log(helpInfo);
        process.exit(1);
      }
      for (const name of cmdArgs) {
        await installPackage(name, pkgManager, cwd);
      }
      process.exit(0);
    }

    case "update": {
      const pkgManager = await getPackageManager();
      const cwd = process.cwd();

      if (!cmdArgs.length || cmdArgs[0] === "check") {
        // 检查更新
        const packages = await getInstalledPackages(cwd);
        const updates = await checkUpdates(packages, pkgManager, cwd);
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
          await updatePackage(pkg, pkgManager, cwd);
        }
        process.exit(0);
      }

      if (target === "self") {
        await updatePackage("mioku", pkgManager, cwd);
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
            await updatePackage(pkg, pkgManager, cwd);
          }
        } else {
          const prefix = target === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
          const normalized = name.startsWith(prefix)
            ? name
            : `${prefix}${name}`;
          await updatePackage(normalized, pkgManager, cwd);
        }
        process.exit(0);
      }

      // update xxx - 更新指定包，自动识别前缀
      const packages = await getInstalledPackages(cwd);
      if (packages.includes(target)) {
        await updatePackage(target, pkgManager, cwd);
      } else {
        const normalized = normalizePackageName(target);
        await updatePackage(normalized, pkgManager, cwd);
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

        case cli.help:
          console.log(helpInfo);
          process.exit(0);
      }

      let {
        name = await input("请输入项目名称", {
          default: "mioku-bot",
          placeholder: "mioku-bot",
          required: true,
        }),
        owners = await input("请输入主人 QQ (最高权限，英文逗号分隔，必填)", {
          placeholder: "请输入",
          default: "",
          required: true,
        }),
        token,
        protocol,
        host,
        port,
        prefix,
        admins,
        "use-npm-mirror": useNpmMirror,
      } = cli;

      if (name && owners) {
        protocol ||= "ws";
        host ||= "localhost";
        port ||= 3001;
        token ||= "";
        prefix ||= "#";
        admins ||= "";
        useNpmMirror ??= false;
      } else {
        token ||= await input("请输入 NapCat WS Token", {
          default: "",
          placeholder: "请输入",
        });
        protocol ||= await input("请输入 NapCat WS 协议", {
          default: "ws",
          placeholder: "ws",
          required: true,
        });
        host ||= await input("请输入 NapCat WS 主机", {
          default: "localhost",
          placeholder: "localhost",
          required: true,
        });
        port ||= parseInt(
          await input("请输入 NapCat WS 端口", {
            default: "3001",
            placeholder: "3001",
            required: true,
          }),
        );
        prefix ||= await input("请输入消息命令前缀", {
          default: "#",
          placeholder: "#",
          required: true,
        });
        admins ||=
          (await input("请输入管理员 QQ (插件权限，英文逗号分隔，可空)", {
            placeholder: "可空",
          })) || "";
        useNpmMirror ??= await confirm("是否使用 npm 镜像源加速依赖安装？", {
          initial: false,
        });
      }

      const installWebui = await confirm("是否安装 WebUI？(建议安装)", {
        initial: true,
      });

      // Select and validate package manager
      const pkgManager = await selectPackageManager();
      const pm = ensurePackageManager(pkgManager);

      const pkgJson = dedent(`
      {
        "name": "${name}",
        "private": true,
        "type": "module",
        "dependencies": {},
        "mioki": {
          "prefix": "${prefix}",
          "owners": [${String(owners)
            .split(",")
            .map((o) => o.trim())
            .join(", ")}],
          "admins": [${
            admins
              ? String(admins)
                  .split(",")
                  .map((o) => `"${o.trim()}"`)
                  .join(", ")
              : ""
          }],
          "plugins": ["boot", "help", "chat", "demo"],
          "log_level": "info",
          "online_push": true,
          "error_push": true,
          "napcat": [
            {
              "protocol": "${protocol}",
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

      const npmrc = dedent(`
      registry=https://registry.npmmirror.com
      fund=false
`);

      const fileTree: Record<string, any> = {
        "app.ts":
          "import { start } from 'mioku'\n\nstart({ cwd: import.meta.dirname }).then()\n",
        "package.json": pkgJson,
        plugins: { demo: { "index.ts": pluginCode } },
        config: {},
        data: {},
        ...(useNpmMirror ? { ".npmrc": npmrc } : {}),
      };

      createNewProject(name, fileTree, { installWebui, pkgManager: pm });
    }
  }
})();

async function createNewProject(
  name: string,
  fileTree: Record<string, any>,
  options: { installWebui: boolean; pkgManager: string },
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

  const addCommand = getAddCommand(options.pkgManager, DEFAULT_PACKAGES);
  console.log(`正在安装 Mioku 依赖: ${addCommand}`);
  execSync(addCommand, { cwd: projectPath, stdio: "inherit" });

  console.log(`\ncd ${projectPath} && ${options.pkgManager} start\n`);

  if (options.installWebui) {
    console.log("WebUI 将通过 mioku 框架自动加载，无需额外安装。");
  }
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
