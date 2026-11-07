import type { MessageEvent } from "mioku";
import type { ChatPluginContext } from "../context";
import { toOptionalId } from "../utils/record";

const USAGE = [
  ".记忆                查看记忆状态",
  ".记忆 搜索 <关键词>  只搜本群的记忆条目",
  ".记忆 轮廓 <群员>    查看某个群员的画像",
  ".记忆 抽取          立即抽取本群记忆",
  ".记忆 忘掉 <id>      删除一条记忆",
  ".记忆 清空          清空本群记忆",
  ".记忆 重建          重建向量索引",
].join("\n");

function formatTime(timestamp: number): string {
  if (!timestamp) return "从未";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 记忆运维命令。
 *
 * 这些是给管理员「看得见、能兜底」用的：状态、检索、忘掉、清空、重建。
 * 普通成员的检索直接走模型工具，不需要记命令。
 */
export async function handleMemoryCommand(
  pluginCtx: ChatPluginContext,
  event: MessageEvent,
  rawArgs: string,
): Promise<void> {
  const { ctx, memory } = pluginCtx;
  if (!memory) {
    await event.reply("记忆功能未启用（缺少 vector 服务？）", true);
    return;
  }

  const groupId =
    event.message_type === "group" ? toOptionalId(event.group_id) : undefined;
  if (!groupId) {
    await event.reply("群聊记忆只能在群里查看哦~", true);
    return;
  }

  const [action, ...rest] = rawArgs.split(/\s+/).filter(Boolean);
  const arg = rest.join(" ").trim();
  const sessionId = `group:${groupId}`;

  if (!action) {
    const status = memory.status();
    await event.reply(
      [
        "群聊记忆状态：",
        `开关：${status.enabled ? "开" : "关"}｜语义检索：${status.vectorReady ? "就绪" : "未就绪（只用关键词）"}`,
        `记忆：${status.items} 条（${status.groups} 个群）｜轮廓：${status.profiles} 个`,
        `待抽取：${status.buffered} 条 / ${status.bufferGroups} 个群`,
        `本轮已注入：${status.injected} 次｜注入缓存：${status.cacheEntries} 条`,
        `上次抽取：${formatTime(status.lastExtractAt)}`,
        status.lastError ? `最近错误：${status.lastError.slice(0, 120)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      true,
    );
    return;
  }

  if (action === "搜索" || action === "搜索记忆") {
    if (!arg) {
      await event.reply("用法：.记忆 搜索 <关键词>", true);
      return;
    }
    const result = await memory.recallGroupContext({
      groupId,
      sessionId,
      query: arg,
      onlyMemories: true,
      literalFirst: true,
    });
    await event.reply(result || "没查到相关内容。", true);
    return;
  }

  if (action === "轮廓" || action === "画像") {
    if (!arg) {
      await event.reply("用法：.记忆 轮廓 <群员名字或id>", true);
      return;
    }
    const result = await memory.profileOfMember({ groupId, who: arg });
    await event.reply(result || `还没有 ${arg} 的画像。`, true);
    return;
  }

  if (!(ctx.isAdmin(event) || ctx.isOwner(event) || ctx.isMaster(event))) {
    await event.reply("这个操作需要管理员哦~", true);
    return;
  }

  if (action === "抽取") {
    await memory.flush(groupId);
    const status = memory.status();
    await event.reply(
      `已触发抽取。当前本群记忆 ${status.items} 条（全局），待抽取 ${status.buffered} 条。`,
      true,
    );
    return;
  }

  if (action === "忘掉" || action === "删除") {
    const id = Number(arg);
    if (!Number.isFinite(id) || id <= 0) {
      await event.reply("用法：.记忆 忘掉 <记忆id>", true);
      return;
    }
    const ok = await memory.forgetItem(groupId, id);
    await event.reply(ok ? `已忘掉记忆 #${id}` : `没找到记忆 #${id}`, true);
    return;
  }

  if (action === "清空") {
    const count = await memory.clearGroup(groupId);
    await event.reply(`已清空本群记忆（${count} 条）与群员画像。`, true);
    return;
  }

  if (action === "重建") {
    const result = await memory.reindex();
    await event.reply(result, true);
    return;
  }

  await event.reply(USAGE, true);
}
