import type { MiokuContext } from "../../../runtime/mioku-context";
import { isEventMaster } from "../../../runtime/mioku-context";
import { getPluginRuntimeState } from "../../../runtime/plugin-state";
import { replyText } from "./notify";
import {
  checkUpdates,
  diffVersions,
  snapshotAll,
  updateAllManaged,
  updatePackages,
  type UpdateAvailable,
} from "../system/package-manager";
import { triggerRestart, type RestartMarker } from "../system/restart";

const SELECT_TIMEOUT_MS = 60000;

interface PendingSelection {
  disposer: () => void;
  timer: ReturnType<typeof setTimeout>;
  items: UpdateAvailable[];
}

const RUNTIME_KEY = "updateSelections";

function getPendingMap(): Map<string, PendingSelection> {
  const state = getPluginRuntimeState("core");
  if (!state[RUNTIME_KEY]) {
    state[RUNTIME_KEY] = new Map<string, PendingSelection>();
  }
  return state[RUNTIME_KEY] as Map<string, PendingSelection>;
}

function conversationKey(event: any): string {
  const selfId = String(event?.self_id ?? "");
  const adapter = String(event?.bot?.adapter ?? "");
  if (event?.message_type === "group" && event?.group_id) {
    return `${adapter}:${selfId}:g:${String(event.group_id)}`;
  }
  return `${adapter}:${selfId}:p:${String(event?.user_id ?? "")}`;
}

function typeLabel(type: string): string {
  if (type === "plugin") return "plugin";
  if (type === "service") return "service";
  return "框架";
}

function renderUpdateList(items: UpdateAvailable[]): string {
  const lines = items.map((item, idx) => {
    const label = typeLabel(item.type);
    return `${idx + 1}. [${label}] ${item.shortName}  ${item.current} → ${item.latest}`;
  });
  return [
    "以下包存在可用更新",
    ...lines,
    "",
    "用空格隔开需要更新的包编号，回复 all 更新全部",
  ].join("\n");
}

function parseSelection(
  text: string,
  total: number,
): { all: boolean; indices: number[] } {
  const normalized = text.trim().toLowerCase();
  if (normalized === "all" || normalized === "全部") {
    return { all: true, indices: [] };
  }
  const indices: number[] = [];
  for (const token of normalized.split(/\s+/)) {
    if (!token) continue;
    const num = Number(token);
    if (Number.isInteger(num) && num >= 1 && num <= total) {
      indices.push(num - 1);
    }
  }
  return { all: false, indices: Array.from(new Set(indices)) };
}

async function performUpdateAndReport(
  ctx: MiokuContext,
  event: any,
  names: string[],
): Promise<void> {
  if (names.length === 0) {
    await replyText(event, "没有需要更新的项。");
    return;
  }
  const before = snapshotAll(names);
  await replyText(event, `正在更新 ${names.length} 个包，请稍候...`);
  const result = await updatePackages(names);
  if (result.code !== 0) {
    ctx.logger.error(`[core] 更新失败: ${result.stderr || result.stdout}`);
    await replyText(event, `更新失败：${result.stderr || result.stdout}`);
    return;
  }
  const diffs = diffVersions(names, before);
  const changed = diffs.filter((d) => d.changed);
  const unchanged = diffs.filter((d) => !d.changed);

  if (changed.length === 0) {
    await replyText(event, "更新完成，所有包均已是最新版本");
    return;
  }

  const lines = changed.map((d) => `• ${d.name}: ${d.before} → ${d.after}`);
  const parts = [`更新完成，共 ${changed.length} 个包已升级：`, ...lines];
  if (unchanged.length > 0) {
    parts.push("", `另有 ${unchanged.length} 个包已是最新`);
  }
  parts.push("", "即将重启...");
  await replyText(event, parts.join("\n"));

  const selfId = String(event?.self_id ?? "");
  const groupId =
    event?.message_type === "group" && event?.group_id
      ? String(event.group_id)
      : null;
  const userId = String(event?.user_id ?? "");
  const marker: RestartMarker = {
    initiatedAt: Date.now(),
    selfId,
    groupId,
    userId,
    adapter: event?.bot?.adapter,
  };
  triggerRestart(marker);
}

export function registerUpdateCommands(ctx: MiokuContext): () => void {
  const dispose = ctx.command({
    name: "update",
    aliases: ["更新"],
    permission: "master",
    priority: -1000,
    description: "检查并选择插件/服务更新",
    handler: async ({ event, args }) => {
    const prefix = String(ctx.config.prefix ?? ".");
    const arg = args.join(" ").trim();
    const selfId = String(event?.self_id || "");
    const bot = event.bot;
    if (!bot) return;

    if (arg === "all") {
      const managed = await updateAllManaged();
      if (managed.names.length === 0) {
        await replyText(event, "未找到可更新的 mioku 包");
        return;
      }
      await performUpdateAndReport(ctx, event, managed.names);
      return;
    }

    if (arg === "mioku" || arg === "self") {
      await performUpdateAndReport(ctx, event, ["mioku"]);
      return;
    }

    if (arg.startsWith("plugin ") || arg.startsWith("service ")) {
      const [typeRaw, ...rest] = arg.split(/\s+/);
      const name = rest.join(" ").trim();
      const type = typeRaw === "plugin" ? "plugin" : "service";
      if (!name) {
        await replyText(event, `用法：${prefix}update ${type} <名称>`);
        return;
      }
      const pkgPrefix = type === "plugin" ? "mioku-plugin-" : "mioku-service-";
      const fullName = name.startsWith(pkgPrefix) ? name : `${pkgPrefix}${name}`;
      await performUpdateAndReport(ctx, event, [fullName]);
      return;
    }

    if (arg === "check" || arg === "检查") {
      const pending = getPendingMap();
      const key = conversationKey(event);
      const existing = pending.get(key);
      if (existing) {
        existing.disposer();
        clearTimeout(existing.timer);
        pending.delete(key);
      }

      let items: UpdateAvailable[];
      try {
        items = await checkUpdates();
      } catch (error) {
        ctx.logger.error(`[core] 检查更新失败: ${error}`);
        await replyText(event, `检查更新失败：${String(error)}`);
        return;
      }

      if (items.length === 0) {
        await replyText(event, "所有插件与服务均已是最新版本");
        return;
      }

      await replyText(event, renderUpdateList(items));

      const timeoutMs = SELECT_TIMEOUT_MS;
      const listenerDispose = ctx.handle("message", async (ev: any) => {
        if (String(ev?.self_id || "") !== selfId) return;
        if (conversationKey(ev) !== key) return;
        if (!isEventMaster(ev)) return;

        const evText = ctx.text(ev)?.trim() || "";
        if (evText.startsWith(`${prefix}update`)) return;

        const sel = pending.get(key);
        if (!sel) return;

        clearTimeout(sel.timer);
        sel.disposer();
        pending.delete(key);

        const parsed = parseSelection(evText, sel.items.length);
        const chosen = parsed.all
          ? sel.items
          : parsed.indices.map((i) => sel.items[i]).filter(Boolean);

        if (chosen.length === 0) {
          await replyText(event, "未选择任何有效项，已取消");
          return;
        }
        await performUpdateAndReport(
          ctx,
          event,
          chosen.map((i) => i.name),
        );
      });

      const timer = setTimeout(async () => {
        const sel = pending.get(key);
        if (!sel) return;
        sel.disposer();
        pending.delete(key);
        await replyText(event, "操作超时，已取消更新");
      }, timeoutMs);

      pending.set(key, { disposer: listenerDispose, timer, items });
      return;
    }

    await replyText(
      event,
      `用法：\n${prefix}update check  检查并选择更新\n${prefix}update all  更新全部\n${prefix}update mioku  更新框架\n${prefix}update plugin <名称>\n${prefix}update service <名称>`,
    );
    },
  });

  return () => {
    dispose();
    const pending = getPendingMap();
    for (const sel of pending.values()) {
      clearTimeout(sel.timer);
      sel.disposer();
    }
    pending.clear();
  };
}
