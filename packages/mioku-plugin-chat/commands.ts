import type { MessageEvent } from "mioku";
import type { ChatPluginContext } from "./context";
import { handleTtsCommand } from "./handlers/tts-command";
import { handleMemoryCommand } from "./handlers/memory-command";
import { toOptionalId } from "./utils/record";
import { eventUserId } from "./utils/sender";

function isFromSelf(event: MessageEvent): boolean {
  return String(event.user_id ?? "") === String(event.self_id ?? "");
}

function groupIdOf(event: MessageEvent): string | undefined {
  return event.message_type === "group"
    ? toOptionalId(event.group_id)
    : undefined;
}

function resetSession(pluginCtx: ChatPluginContext, sessionId: string): void {
  pluginCtx.sessionManager.resetBotMessages(sessionId);
  pluginCtx.groupStructuredHistory.clear(sessionId);
}

export function registerChatCommands(pluginCtx: ChatPluginContext): void {
  const { ctx } = pluginCtx;

  ctx.command({
    name: "重置会话",
    prefixes: ["/", "."],
    match: /^重置会话$/,
    description: "重置自己的AI聊天记录",
    usage: ".重置会话",
    handler: async ({ event }) => {
      if (isFromSelf(event)) return;
      if (groupIdOf(event)) {
        await event.reply("群会话需要管理员使用 .重置群会话 哦~", true);
        return;
      }
      resetSession(pluginCtx, `personal:${eventUserId(event)}`);
      await event.reply("已清除你的个人会话中 AI 发送的消息~");
    },
  });

  ctx.command({
    name: "重置群会话",
    prefixes: ["/", "."],
    match: /^重置群会话$/,
    permission: "admin",
    description: "重置当前群的AI聊天记录",
    usage: ".重置群会话",
    handler: async ({ event }) => {
      if (isFromSelf(event)) return;
      const groupId = groupIdOf(event);
      if (!groupId) {
        await event.reply("在群里使用试试看吧~", true);
        return;
      }
      resetSession(pluginCtx, `group:${groupId}`);
      await event.reply("已清除本群会话中 AI 发送的消息~");
    },
  });

  ctx.command({
    name: "记忆",
    prefixes: ["/", "."],
    match: /^记忆(?:\s+([\s\S]*))?$/,
    description: "查看/检索/清理群聊记忆",
    usage: [
      ".记忆                查看记忆状态",
      ".记忆 搜索 <关键词>  只搜本群的记忆条目",
      ".记忆 轮廓 <群员>    查看某个群员的画像",
      ".记忆 抽取          立即抽取本群记忆（需已攒够消息）",
      ".记忆 忘掉 <id>      删除一条记忆",
      ".记忆 清空          清空本群记忆",
      ".记忆 重建          重建向量索引（换模型后用）",
    ].join("\n"),
    handler: async ({ event, match }) => {
      if (isFromSelf(event)) return;
      await handleMemoryCommand(
        pluginCtx,
        event,
        String(match?.[1] ?? "").trim(),
      );
    },
  });

  ctx.command({
    name: "tts",
    prefixes: ["/", "."],
    match: /^tts\s*(.*)$/,
    description: "TTS 推理",
    usage: ".tts <文本>",
    handler: async ({ event, match }) => {
      if (isFromSelf(event)) return;
      await handleTtsCommand(pluginCtx, event, String(match?.[1] ?? "").trim());
    },
  });
}
