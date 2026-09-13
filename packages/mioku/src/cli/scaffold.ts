import fs from "node:fs";
import path from "node:path";
import dedent from "dedent";
import consola from "consola";
import {
  ADAPTER_PREFIX,
  PLUGIN_PREFIX,
  ensurePackageManager,
  getAddCommand,
  multiSelect,
  run,
  runAdapterCli,
  searchMiokuPackages,
  fetchOfficialRegistry,
  shortNameOfPackage,
  resolveRequiredServices,
  rmrf,
  withRoot,
  gracefullyExit,
  makeFileTree,
  input,
  confirm,
} from "./shared";

/** stdin 会话对应的主人标识，默认追加到 mioku.owners */
export const STDIN_OWNER = "stdin";

/** 系统自带适配器：必装且不可取消，默认启用 */
export const SYSTEM_ADAPTERS = ["mioku-adapter-stdin"];

/** 系统自带插件：必装且不可取消 */
export const SYSTEM_PLUGINS = ["mioku-plugin-help", "mioku-plugin-chat"];

/** 系统服务：框架运行所必需，无条件安装 */
export const SYSTEM_SERVICES = [
  "mioku-service-ai",
  "mioku-service-config",
  "mioku-service-screenshot",
  "mioku-service-help",
];

async function createNewProject(
  name: string,
  fileTree: Record<string, string | Record<string, unknown>>,
): Promise<string> {
  const projectPath = withRoot(`./${name}`);

  if (fs.existsSync(projectPath)) {
    const overwrite = await confirm(`项目 ${name} 已存在，是否覆盖？`);
    if (!overwrite) gracefullyExit();

    if (projectPath === process.cwd()) {
      if (fs.readdirSync(projectPath).length !== 0) {
        const confirmOver = await confirm(
          "项目路径与当前路径相同，将删除当前目录下所有内容再创建，是否继续？",
        );
        if (!confirmOver) gracefullyExit();
      }
    }
    await rmrf(projectPath);
  }

  fs.mkdirSync(projectPath, { recursive: true });
  makeFileTree(fileTree, projectPath);
  console.log(`项目 ${name} 创建成功！`);

  console.log("正在安装基础依赖 (bun i) ...");
  run("bun", ["i"], { cwd: projectPath });
  return projectPath;
}

async function selectPackages(
  message: string,
  prefix: string,
  initial: string[] = [],
  options: { exclude?: string[] } = {},
): Promise<string[]> {
  console.log(`\n正在从 npm 拉取 ${prefix}* 包...`);
  const [hits, registry] = await Promise.all([
    searchMiokuPackages(prefix),
    fetchOfficialRegistry(),
  ]);
  if (hits.length === 0) {
    consola.warn(`未在 npm 上找到任何 ${prefix}* 包`);
    return [];
  }
  const official = new Set<string>();
  for (const group of [registry?.plugins, registry?.services, registry?.adapters]) {
    for (const entry of Object.values(group ?? {})) {
      if (entry?.npm) official.add(entry.npm);
    }
  }
  const excludeSet = new Set(options.exclude ?? []);
  const items = hits
    .filter((hit) => !excludeSet.has(hit.name))
    .map((hit) => {
      const shortName = shortNameOfPackage(hit.name);
      const desc = hit.description || "暂无介绍";
      const badge = official.has(hit.name) ? "官方" : "社区";
      return { label: `${shortName}  (${badge} · ${desc})`, value: hit.name };
    });
  return multiSelect(message, items, initial, { required: false });
}

export async function scaffoldCommand(): Promise<number> {
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

  ensurePackageManager();

  // stdin 会话默认拥有主人权限：自动追加到 owners
  const ownersList = [
    ...String(owners)
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    STDIN_OWNER,
  ];

  const adapterNames = await selectPackages(
    "选择要安装的适配器（上下键选择，空格勾选，回车确认）",
    ADAPTER_PREFIX,
    [],
    { exclude: SYSTEM_ADAPTERS },
  );
  const allAdapterNames = [...SYSTEM_ADAPTERS, ...adapterNames];
  if (adapterNames.length === 0) {
    consola.info("未选择其他适配器，仅启用标准输入");
  }

  const pkgJsonObj = {
    name,
    private: true,
    type: "module" as const,
    dependencies: {
      mioku: "latest",
      ...Object.fromEntries(allAdapterNames.map((p) => [p, "latest"])),
      ...Object.fromEntries(SYSTEM_PLUGINS.map((p) => [p, "latest"])),
    },
    mioku: {
      prefix: ".",
      owners: ownersList,
      admins: [] as string[],
      plugins: ["demo"],
      log_level: "info",
      online_push: false,
      error_push: false,
      adapters: {
        stdin: {},
      },
    },
    scripts: {
      start: "bun run app.ts",
      dev: "bun run --watch app.ts",
    },
  };
  const pkgJson = `${JSON.stringify(pkgJsonObj, null, 2)}\n`;

  const pluginCode = dedent(`
    import { definePlugin } from 'mioku'

    export default definePlugin({
      name: 'demo',
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

  const fileTree: Record<string, string | Record<string, unknown>> = {
    "app.ts":
      "import { start } from 'mioku'\n\nstart({ cwd: import.meta.dirname }).then()\n",
    "package.json": pkgJson,
    plugins: { demo: { "index.ts": pluginCode } },
    config: {},
    data: {},
  };

  const projectPath = await createNewProject(name, fileTree);

  // 仅为用户额外选择的适配器运行配置向导（系统适配器 stdin 免配置）
  for (const adapterPkg of adapterNames) {
    const adapterName = shortNameOfPackage(adapterPkg);
    consola.info(`正在运行 ${adapterPkg} 配置向导...`);
    runAdapterCli(adapterName, projectPath);
  }
  consola.info(
    `已自动安装并启用系统适配器: ${SYSTEM_ADAPTERS.map(shortNameOfPackage).join(", ")}`,
  );

  // 系统插件必装且不可取消：从选择列表中剔除，自动启用
  const pluginNames = await selectPackages(
    "选择要安装的插件（上下键选择，空格勾选，回车确认）",
    PLUGIN_PREFIX,
    [],
    { exclude: SYSTEM_PLUGINS },
  );
  consola.info(
    `系统插件将自动安装: ${SYSTEM_PLUGINS.map(shortNameOfPackage).join(", ")}`,
  );

  const enabledPlugins = [
    "demo",
    ...SYSTEM_PLUGINS.map(shortNameOfPackage),
    ...pluginNames.map(shortNameOfPackage),
  ];
  const pkgPath = path.join(projectPath, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.mioku = { ...pkg.mioku, plugins: enabledPlugins };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const serviceNames = new Set<string>(SYSTEM_SERVICES);
  for (const service of await resolveRequiredServices(pluginNames)) {
    serviceNames.add(service);
  }
  consola.info(
    `将自动安装服务: ${Array.from(serviceNames).map(shortNameOfPackage).join(", ")}`,
  );

  const installWebui = await confirm("是否安装 WebUI 管理面板？（建议安装）", {
    initial: true,
  });

  const addPackages = [...pluginNames, ...Array.from(serviceNames)];
  if (installWebui) addPackages.push("mioku-service-webui");

  if (addPackages.length > 0) {
    const [cmd, args] = getAddCommand(addPackages);
    console.log(`正在安装插件与服务: ${cmd} ${args.join(" ")}`);
    run(cmd, args, { cwd: projectPath });
  }

  console.log("\n若需启动机器人，请运行：");
  console.log("  cd", name);
  console.log("  bun run start");
  return 0;
}
