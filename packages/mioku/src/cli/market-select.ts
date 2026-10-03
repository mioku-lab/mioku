import consola from "consola";
import {
  ADAPTER_PREFIX,
  PLUGIN_PREFIX,
  SERVICE_PREFIX,
  fetchOfficialRegistry,
  hiddenShortNames,
  multiSelect,
  searchMiokuPackages,
  shortNameOfPackage,
  type MarketPackageType,
} from "./shared";

export type { MarketPackageType };

export const PACKAGE_TYPE_PREFIX: Record<MarketPackageType, string> = {
  plugin: PLUGIN_PREFIX,
  service: SERVICE_PREFIX,
  adapter: ADAPTER_PREFIX,
};

/** 从 npm 拉取市场包并让用户多选；官方注册表 hidden 名单内的包不展示 */
export async function pickMarketPackages(
  type: MarketPackageType,
  message: string,
  options: { exclude?: string[] } = {},
): Promise<string[]> {
  const prefix = PACKAGE_TYPE_PREFIX[type];
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

  const hidden = hiddenShortNames(registry, type);
  const excludeSet = new Set(options.exclude ?? []);
  const items = hits
    .filter(
      (hit) =>
        !excludeSet.has(hit.name) && !hidden.has(shortNameOfPackage(hit.name)),
    )
    .map((hit) => {
      const shortName = shortNameOfPackage(hit.name);
      const desc = hit.description || "暂无介绍";
      const badge = official.has(hit.name) ? "官方" : "社区";
      return { label: `${shortName}  (${badge} · ${desc})`, value: hit.name };
    });
  return multiSelect(message, items, [], { required: false });
}
