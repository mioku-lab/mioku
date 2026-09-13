import type { MiokuContext } from "../../../runtime/mioku-context";
import { replyText } from "./notify";
import { installPackage, uninstallPackage } from "../system/package-manager";

function parseTargetArgs(
  args: readonly string[],
): { type: "plugin" | "service"; name: string } | null {
  const type = args[0];
  if (type !== "plugin" && type !== "service") return null;
  const name = args.slice(1).join(" ").trim();
  if (!name) return null;
  return { type, name };
}

function typeLabel(type: "plugin" | "service"): string {
  return type === "plugin" ? "插件" : "服务";
}

export function registerInstallCommands(ctx: MiokuContext): () => void {
  const register = (name: "install" | "uninstall") => ctx.command({
    name,
    aliases: name === "install" ? ["安装"] : ["卸载"],
    permission: "master",
    priority: -1000,
    description: name === "install" ? "从 npm 安装插件/服务" : "卸载插件/服务",
    handler: async ({ event, args }) => {
    if (name === "install") {
      const parsed = parseTargetArgs(args);
      if (!parsed) {
        await replyText(
          event,
          `用法：${ctx.config.prefix ?? "."}install plugin <名称> 或 ${ctx.config.prefix ?? "."}install service <名称>`,
        );
        return;
      }
      await replyText(
        event,
        `正在从 npm 安装${typeLabel(parsed.type)} ${parsed.name}...`,
      );
      try {
        const result = await installPackage(parsed.type, parsed.name);
        if (!result.ok) {
          ctx.logger.error(`[core] 安装失败: ${result.error || result.output}`);
          await replyText(event, `安装失败：${result.error || result.output}`);
          return;
        }
        const lines = [
          `已安装 ${result.packageName}`,
          result.enabled ? "已在 plugins 中启用" : "",
          "重启后生效",
        ].filter(Boolean);
        await replyText(event, lines.join("\n"));
      } catch (error) {
        ctx.logger.error(`[core] 安装失败: ${error}`);
        await replyText(event, `安装失败：${String(error)}`);
      }
      return;
    }

    const parsed = parseTargetArgs(args);
    if (!parsed) {
      await replyText(
        event,
        `用法：${ctx.config.prefix ?? "."}uninstall plugin <名称> 或 ${ctx.config.prefix ?? "."}uninstall service <名称>`,
      );
      return;
    }
    await replyText(
      event,
      `正在卸载${typeLabel(parsed.type)} ${parsed.name}...`,
    );
    try {
      const result = await uninstallPackage(parsed.type, parsed.name);
      if (!result.ok) {
        ctx.logger.error(`[core] 卸载失败: ${result.error || result.output}`);
        await replyText(event, `卸载失败：${result.error || result.output}`);
        return;
      }
      const lines = [
        `已卸载 ${result.packageName}`,
        result.removedFromConfig ? "已从 plugins 中移除" : "",
        "重启后生效",
      ].filter(Boolean);
      await replyText(event, lines.join("\n"));
    } catch (error) {
      ctx.logger.error(`[core] 卸载失败: ${error}`);
      await replyText(event, `卸载失败：${String(error)}`);
    }
    },
  });
  const install = register("install");
  const uninstall = register("uninstall");
  return () => {
    install();
    uninstall();
  };
}
