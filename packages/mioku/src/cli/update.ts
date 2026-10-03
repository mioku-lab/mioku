import consola from "consola";
import {
  ensurePackageManager,
  fetchNpmPackageMeta,
  getInstalledPackages,
  installedVersionOf,
  multiSelect,
  run,
  PLUGIN_PREFIX,
  SERVICE_PREFIX,
} from "./shared";

async function updatePackages(packages: string[], cwd: string): Promise<void> {
  if (packages.length === 0) {
    consola.info("未找到 mioku 相关依赖");
    return;
  }
  console.log(`执行: bun update ${packages.join(" ")} --latest`);
  run("bun", ["update", ...packages, "--latest"], { cwd });
}

async function updateByPrefix(
  prefix: string,
  cwd: string,
  name?: string,
): Promise<void> {
  if (name) {
    const normalized = name.startsWith(prefix) ? name : `${prefix}${name}`;
    console.log(`执行: bun update ${normalized} --latest`);
    run("bun", ["update", normalized, "--latest"], { cwd });
    return;
  }
  const packages = (await getInstalledPackages(cwd)).filter((p) =>
    p.startsWith(prefix),
  );
  if (packages.length === 0) {
    consola.info(`未找到 ${prefix}* 相关依赖`);
    return;
  }
  await updatePackages(packages, cwd);
}

interface OutdatedPackage {
  name: string;
  current: string;
  latest: string;
}

/** latest 是否比 current 更新（按数字段比较，避免把已装的新版本倒退回去） */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split("-");
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  // 同主版本：正式版 > 预发布
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  return a.pre > b.pre;
}

/** 对比 npm 上的最新版本，找出所有可更新的 mioku 包（含框架本身） */
async function collectOutdated(cwd: string): Promise<OutdatedPackage[]> {
  const packages = await getInstalledPackages(cwd);
  const checked = await Promise.all(
    packages.map(async (name) => ({
      name,
      current: installedVersionOf(cwd, name),
      meta: await fetchNpmPackageMeta(name),
    })),
  );

  const outdated: OutdatedPackage[] = [];
  for (const { name, current, meta } of checked) {
    if (!current) continue;
    const latest = meta?.version;
    if (!latest || !isNewerVersion(latest, current)) continue;
    outdated.push({ name, current, latest });
  }
  return outdated.sort((a, b) => a.name.localeCompare(b.name));
}

/** 检查更新并列出选择框（含 mioku 框架本身），确认后更新选中项 */
async function updateCheckFlow(cwd: string): Promise<number> {
  consola.info("正在检查 mioku 包更新...");
  const outdated = await collectOutdated(cwd);
  if (outdated.length === 0) {
    consola.success("所有 mioku 包均已是最新版本");
    return 0;
  }

  consola.info(`发现 ${outdated.length} 个可更新包`);
  const items = outdated.map((o) => ({
    label: `${o.name}  ${o.current} → ${o.latest}`,
    value: o.name,
  }));

  let selected: string[];
  try {
    selected = await multiSelect(
      "选择要更新的包（空格勾选，回车确认）",
      items,
      [],
    );
  } catch {
    consola.info("已取消");
    return 0;
  }
  if (selected.length === 0) {
    consola.info("未选择任何包");
    return 0;
  }
  await updatePackages(selected, cwd);
  return 0;
}

export async function updateCommand(cmdArgs: string[]): Promise<number> {
  ensurePackageManager();
  const cwd = process.cwd();
  const [target, name] = cmdArgs;

  if (!target || target === "check") {
    return updateCheckFlow(cwd);
  }

  if (target === "all") {
    await updatePackages(await getInstalledPackages(cwd), cwd);
    return 0;
  }

  if (target === "self") {
    console.log("执行: bun update mioku --latest");
    run("bun", ["update", "mioku", "--latest"], { cwd });
    return 0;
  }

  if (target === "plugin" || target === "service") {
    const prefix = target === "plugin" ? PLUGIN_PREFIX : SERVICE_PREFIX;
    await updateByPrefix(prefix, cwd, name);
    return 0;
  }

  console.log(`执行: bun update ${target} --latest`);
  run("bun", ["update", target, "--latest"], { cwd });
  return 0;
}
