import type { MiokuContext } from "../../../runtime/mioku-context";
import { replyText, sendTextOrForward } from "./notify";
import { getMarketItems } from "../system/package-manager";

function renderMarketText(
  kind: "plugin" | "service",
  items: Awaited<ReturnType<typeof getMarketItems>>,
): string {
  const label = kind === "plugin" ? "插件" : "服务";
  const lines = items.map((item) => {
    const status = item.installed
      ? item.hasUpdate
        ? `可更新 ${item.installedVersion}→${item.latest}`
        : `已安装 ${item.installedVersion}`
      : `未安装${item.latest ? `（最新 ${item.latest}）` : ""}`;
    return `• ${item.name}  [${status}]\n  ${item.description}`;
  });
  return [`Mioku ${label}市场（共 ${items.length} 个）`, ...lines].join("\n");
}

export function registerMarketCommands(ctx: MiokuContext): () => void {
  const pluginMarket = ctx.command({
    id: "market",
    name: "plugin-market",
    aliases: ["插件市场"],
    permission: "master",
    priority: -1000,
    description: "查看插件市场",
    handler: (input) => handleMarket(ctx, input.event, "plugin"),
  });
  const serviceMarket = ctx.command({
    id: "market",
    name: "service-market",
    aliases: ["服务市场"],
    permission: "master",
    priority: -1000,
    description: "查看服务市场",
    handler: (input) => handleMarket(ctx, input.event, "service"),
  });
  return () => {
    pluginMarket();
    serviceMarket();
  };
}

async function handleMarket(
  ctx: MiokuContext,
  event: any,
  kind: "plugin" | "service",
): Promise<void> {

    let items;
    try {
      items = await getMarketItems(kind);
    } catch (error) {
      ctx.logger.error(`[core] 获取市场信息失败: ${error}`);
      await replyText(event, `获取市场失败：${String(error)}`);
      return;
    }

    await sendTextOrForward({
      ctx,
      event,
      text: renderMarketText(kind, items),
      source: `Mioku ${kind === "plugin" ? "插件" : "服务"}市场`,
      summary: `共 ${items.length} 个`,
    });
}
