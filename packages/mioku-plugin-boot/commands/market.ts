import { type MiokiContext, isOwner } from "mioki";
import type { ScreenshotService } from "mioku";
import { replyNotice, replyText } from "./notify";
import { getCommandPrefix } from "./prefix";
import {
  generateMarketImage,
  replyWithMarketImage,
  resolveBotProfile,
} from "../market/image";
import { getMarketItems, getInstalledVersion } from "../system/package-manager";

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

export function registerMarketCommands(ctx: MiokiContext): () => void {
  const dispose = ctx.handle("message", async (event: any) => {
    const text = ctx.text(event)?.trim();
    if (!text || event?.user_id === event?.self_id) return;

    const prefix = getCommandPrefix();
    const kind: "plugin" | "service" | null =
      text === `${prefix}插件市场` || text === `${prefix}plugin-market`
        ? "plugin"
        : text === `${prefix}服务市场` || text === `${prefix}service-market`
          ? "service"
          : null;
    if (!kind) return;

    if (!isOwner(event)) {
      ctx.logger.warn("[boot] market 指令仅主人可用");
      return;
    }

    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;

    let items;
    try {
      items = await getMarketItems(kind);
    } catch (error) {
      await replyNotice({
        ctx,
        event,
        instruction: "获取市场信息失败，请简要说明失败并建议稍后重试。",
        fallbackMessage: `获取市场失败：${String(error)}`,
        error,
      });
      return;
    }

    if (!screenshotService) {
      ctx.logger.warn("[boot] screenshot 服务未加载，市场以文本形式返回");
      await replyText(event, renderMarketText(kind, items));
      return;
    }

    let imagePath: string | null = null;
    try {
      const profile = resolveBotProfile(ctx, event);
      imagePath = await generateMarketImage({
        screenshotService,
        items,
        kind,
        botAvatarUrl: profile.botAvatarUrl,
        miokuVersion: getInstalledVersion("mioku"),
      });
    } catch (error) {
      ctx.logger.error(`[boot] 市场截图失败: ${error}`);
    }

    if (!imagePath) {
      await replyText(event, renderMarketText(kind, items));
      return;
    }

    try {
      await replyWithMarketImage({ ctx, event, imagePath });
    } catch (error) {
      ctx.logger.error(`[boot] 发送市场图片失败: ${error}`);
      await replyText(event, renderMarketText(kind, items));
    }
  });

  return dispose;
}
