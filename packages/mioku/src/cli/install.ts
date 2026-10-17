import fs from "node:fs";
import path from "node:path";
import consola from "consola";
import {
  ADAPTER_PREFIX,
  PLUGIN_PREFIX,
  SERVICE_PREFIX,
  appendToMiokuPlugins,
  confirm,
  ensurePackageManager,
  execAdd,
  fetchNpmKeywords,
  resolveRequiredServices,
  runAdapterCli,
  selectOne,
  shortNameOfPackage,
} from "./shared";
import { pickMarketPackages, type MarketPackageType } from "./market-select";
import { scaffoldCommand } from "./scaffold";

type InstallTarget = MarketPackageType | "mioku";

const INSTALL_TARGETS: Array<{ label: string; value: InstallTarget }> = [
  { label: "mioku 框架 —— 创建新的机器人项目（同 npx mioku）", value: "mioku" },
  { label: "插件 (plugin) —— 安装到当前项目", value: "plugin" },
  { label: "服务 (service) —— 安装到当前项目", value: "service" },
  { label: "适配器 (adapter) —— 安装到当前项目并运行配置向导", value: "adapter" },
];

export async function installCommand(
  cmdArgs: string[],
  helpInfo: string,
): Promise<number> {
  const [type, name] = cmdArgs;

  if (!type) {
    return installInteractive();
  }

  if (type === "plugin" || type === "service" || type === "adapter") {
    if (!name) {
      return installInteractive(type);
    }
    ensurePackageManager();
    return installNamed(type, name);
  }

  consola.error(`无效的类型 "${type}"，请使用 plugin、service 或 adapter`);
  console.log(helpInfo);
  return 1;
}

/** 不带参数：选择安装 mioku 框架或插件/服务/适配器 */
async function installInteractive(type?: MarketPackageType): Promise<number> {
  let target: InstallTarget;
  if (type) {
    target = type;
  } else {
    try {
      target = await selectOne<InstallTarget>(
        "要安装什么？（上下键选择，回车确认）",
        INSTALL_TARGETS,
      );
    } catch {
      consola.info("已取消");
      return 0;
    }
  }

  if (target === "mioku") {
    return scaffoldCommand();
  }

  ensurePackageManager();
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    consola.error(
      "当前目录不是 mioku 项目（未找到 package.json），请先运行 mioku 创建项目或切换到项目目录",
    );
    return 1;
  }

  const packages = await pickMarketPackages(
    target,
    "选择要安装的包（上下键选择，空格勾选，回车确认）",
  );
  if (packages.length === 0) {
    consola.info("未选择任何包，已取消安装");
    return 0;
  }

  const ok = await confirm(
    `确认安装以下 ${packages.length} 个包？\n${packages.map((p) => `  - ${p}`).join("\n")}`,
  );
  if (!ok) {
    consola.info("已取消安装");
    return 1;
  }
  return installPackages(target, packages, cwd);
}

/** 带类型和名称：直接安装指定包 */
async function installNamed(
  type: MarketPackageType,
  name: string,
): Promise<number> {
  const cwd = process.cwd();
  const prefix =
    type === "plugin" ? PLUGIN_PREFIX : type === "service" ? SERVICE_PREFIX : ADAPTER_PREFIX;
  const normalized = name.startsWith(prefix) ? name : `${prefix}${name}`;

  if (type === "plugin") {
    const proceed = await warnIfPrivatePlugin(normalized);
    if (!proceed) {
      consola.info("已取消安装");
      return 1;
    }
    const services = await resolveRequiredServices([normalized]);
    if (services.length > 0) {
      consola.info(`将一并安装插件声明的服务: ${services.map(shortNameOfPackage).join(", ")}`);
      return installPackages("plugin", [normalized, ...services], cwd);
    }
    return installPackages("plugin", [normalized], cwd);
  }

  return installPackages(type, [normalized], cwd);
}

async function installPackages(
  type: MarketPackageType,
  packages: string[],
  cwd: string,
): Promise<number> {
  try {
    execAdd(packages, cwd);
    consola.success(`已安装 ${packages.join(" ")}`);
  } catch {
    consola.error(`安装失败: ${packages.join(" ")}`);
    return 1;
  }

  if (type === "plugin") {
    for (const pkg of packages) {
      if (!pkg.startsWith(PLUGIN_PREFIX)) continue;
      if (appendToMiokuPlugins(cwd, pkg)) {
        consola.success(`已在 mioku.plugins 中启用 ${shortNameOfPackage(pkg)}`);
      } else {
        consola.info(`${shortNameOfPackage(pkg)} 已在 mioku.plugins 中，跳过`);
      }
    }
  }

  if (type === "adapter") {
    for (const pkg of packages) {
      const adapterName = shortNameOfPackage(pkg);
      consola.info(`正在运行 ${pkg} 配置向导...`);
      runAdapterCli(adapterName, cwd);
    }
  }

  return 0;
}

async function warnIfPrivatePlugin(pkgName: string): Promise<boolean> {
  const keywords = await fetchNpmKeywords(pkgName);
  if (keywords === null) return true;
  if (keywords.includes("mioku")) return true;

  consola.warn(`${pkgName} 看起来是私有插件"`);
  consola.warn("该插件未上架插件市场，可能存在风险");
  return confirm("仍要继续安装吗？", { initial: false });
}
