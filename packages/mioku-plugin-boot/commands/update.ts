import { type MiokiContext, isOwner } from "mioki";
import { getPluginRuntimeState } from "mioku";
import { replyNotice, replyText } from "./notify";
import { getCommandPrefix } from "./prefix";
import {
  checkUpdates,
  diffVersions,
  snapshotAll,
  updateAllManaged,
  updatePackages,
  type UpdateAvailable,
} from "../system/package-manager";

const SELECT_TIMEOUT_MS = 60000;

interface PendingSelection {
  disposer: () => void;
  timer: ReturnType<typeof setTimeout>;
  items: UpdateAvailable[];
}

const RUNTIME_KEY = "updateSelections";

function getPendingMap(): Map<string, PendingSelection> {
  const state = getPluginRuntimeState("boot");
  if (!state[RUNTIME_KEY]) {
    state[RUNTIME_KEY] = new Map<string, PendingSelection>();
  }
  return state[RUNTIME_KEY] as Map<string, PendingSelection>;
}

function conversationKey(event: any): string {
  const selfId = Number(event?.self_id || 0);
  if (event?.message_type === "group" && event?.group_id) {
    return `${selfId}:g:${event.group_id}`;
  }
  return `${selfId}:p:${event?.user_id || 0}`;
}

function typeLabel(type: string): string {
  if (type === "plugin") return "插件";
  if (type === "service") return "服务";
  return "框架";
}

function renderUpdateList(items: UpdateAvailable[]): string {
  const lines = items.map((item, idx) => {
    const label = typeLabel(item.type);
    return `${idx + 1}. [${label}] ${item.shortName}  ${item.current} → ${item.latest}`;
  });
  return [
    "检测到以下可更新项：",
    ...lines,
    "",
    "回复编号（空格分隔）选择要更新的项，回复 all 更新全部。超时将自动取消。",
  ].join("\n");
}

function parseSelection(text: string, total: number): { all: boolean; indices: number[] } {
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
  ctx: MiokiContext,
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
    await replyNotice({
      ctx,
      event,
      instruction: "更新执行失败，请简要说明失败并建议稍后重试。",
      fallbackMessage: `更新失败：${result.stderr || result.stdout}`,
      error: result.stderr || result.stdout,
    });
    return;
  }
  const diffs = diffVersions(names, before);
  const changed = diffs.filter((d) => d.changed);
  const unchanged = diffs.filter((d) => !d.changed);

  if (changed.length === 0) {
    await replyText(event, "更新完成，所有包均已是最新版本。");
    return;
  }

  const lines = changed.map(
    (d) => `• ${d.name}: ${d.before} → ${d.after}`,
  );
  const parts = [
    `更新完成，共 ${changed.length} 个包已升级：`,
    ...lines,
  ];
  if (unchanged.length > 0) {
    parts.push("", `另有 ${unchanged.length} 个包已是最新。`);
  }
  parts.push("", "重启后生效。");
  await replyText(event, parts.join("\n"));
}

export function registerUpdateCommands(ctx: MiokiContext): () => void {
  const dispose = ctx.handle("message", async (event: any) => {
    const text = ctx.text(event)?.trim();
    if (!text || event?.user_id === event?.self_id) return;
    const prefix = getCommandPrefix();
    if (!text.startsWith(`${prefix}update`)) return;

    if (!isOwner(event)) {
      ctx.logger.warn("[boot] update 指令仅主人可用");
      return;
    }

    const arg = text.slice(prefix.length + "update".length).trim();
    const selfId = Number(event?.self_id || 0);
    const bot = ctx.pickBot(selfId);
    if (!bot) return;

    if (arg === "all") {
      const managed = await updateAllManaged();
      if (managed.names.length === 0) {
        await replyText(event, "未找到可更新的 mioku 包。");
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
        await replyText(event, `用法：/update ${type} <名称>`);
        return;
      }
      const prefix = type === "plugin" ? "mioku-plugin-" : "mioku-service-";
      const fullName = name.startsWith(prefix) ? name : `${prefix}${name}`;
      await performUpdateAndReport(ctx, event, [fullName]);
      return;
    }

    if (arg !== "") {
      await replyText(event,
        "用法：\n/update  检查并选择更新\n/update all  更新全部\n/update mioku  更新框架\n/update plugin <名称>\n/update service <名称>");
      return;
    }

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
      await replyNotice({
        ctx,
        event,
        instruction: "检查更新失败，请简要说明失败并建议稍后重试。",
        fallbackMessage: `检查更新失败：${String(error)}`,
        error: error,
      });
      return;
    }

    if (items.length === 0) {
      await replyText(event, "所有插件与服务均已是最新版本。");
      return;
    }

    await replyText(event, renderUpdateList(items));

    const timeoutMs = SELECT_TIMEOUT_MS;
    const listenerDispose = ctx.handle("message", async (ev: any) => {
      if (Number(ev?.self_id || 0) !== selfId) return;
      if (conversationKey(ev) !== key) return;
      if (!isOwner(ev)) return;

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
        await replyText(event, "未选择任何有效项，已取消。");
        return;
      }
      await performUpdateAndReport(ctx, event, chosen.map((i) => i.name));
    });

    const timer = setTimeout(async () => {
      const sel = pending.get(key);
      if (!sel) return;
      sel.disposer();
      pending.delete(key);
      await replyText(event, "选择超时，已取消更新。");
    }, timeoutMs);

    pending.set(key, { disposer: listenerDispose, timer, items });
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
