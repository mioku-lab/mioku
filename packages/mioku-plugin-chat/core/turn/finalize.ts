import type { Bot } from "mioku";
import type { ChatPluginContext } from "../../context";
import type {
  ChatConfig,
  ChatResult,
  ChatTarget,
  ChatTurnEvent,
  ToolContext,
} from "../../types";
import { sendGroupEmoji } from "../send/emoji";
import { sendGroupReply } from "../send/group-reply";
import { sendTextMessage } from "../send/text-message";

export interface FinalizeTurnInput {
  target: ChatTarget;
  cfg: ChatConfig;
  event?: ChatTurnEvent;
  result: Pick<ChatResult, "messages" | "emojiPath">;
  toolCtx: Pick<ToolContext, "sentMessageIndices">;
  send: boolean;
  /** 由真实消息触发（私聊贴纸可以直接 reply） */
  live: boolean;
}

/** 一轮结束后：发送、入库、开启冷却 */
export async function finalizeChatTurn(
  pluginCtx: ChatPluginContext,
  input: FinalizeTurnInput,
): Promise<void> {
  const { target, cfg, event, result, toolCtx } = input;
  const { ctx, sessionManager, audioService } = pluginCtx;
  const { selfId, groupId, sessionId } = target;

  if (!input.send) {
    sessionManager.touch(sessionId);
    return;
  }

  const actingBot = (selfId ? ctx.pickBot(selfId) : undefined) ?? event?.bot;

  if (groupId) {
    const sentMessageIds = await sendGroupReply(ctx, {
      selfId,
      groupId,
      messages: result.messages,
      config: cfg,
      sentIndices: toolCtx.sentMessageIndices,
      audioService,
    });
    await sendGroupEmoji(ctx, actingBot, groupId, result.emojiPath);
    saveBotMessages(pluginCtx, {
      target,
      cfg,
      bot: actingBot,
      messages: result.messages,
      sentMessageIds,
    });
    pluginCtx.cooldownManager.startCooldownTimer(sessionId, groupId, selfId);
  } else {
    const sentIndices = toolCtx.sentMessageIndices;
    for (let i = 0; i < result.messages.length; i++) {
      if (sentIndices?.has(i)) continue;
      await sendTextMessage(ctx, target, result.messages[i], {
        config: cfg,
        audioService,
      });
    }
    if (result.emojiPath) {
      await sendPrivateEmoji(pluginCtx, input, actingBot, result.emojiPath);
    }
  }
  sessionManager.touch(sessionId);
}

async function sendPrivateEmoji(
  pluginCtx: ChatPluginContext,
  input: FinalizeTurnInput,
  actingBot: Bot | undefined,
  emojiPath: string,
): Promise<void> {
  const { ctx } = pluginCtx;
  const { event, target } = input;
  const eventBotId = event?.bot ? String(event.bot.bot_id) : undefined;
  const actingIsEventBot =
    eventBotId == null ||
    (actingBot != null && String(actingBot.bot_id) === eventBotId);
  try {
    const emojiSegment = ctx.segment.image(`file://${emojiPath}`);
    if (input.live && actingIsEventBot && event?.reply) {
      await event.reply([emojiSegment]);
      return;
    }
    if (!actingBot) throw new Error(`bot ${target.selfId} not found`);
    await actingBot.sendMessage({ type: "private", user_id: target.userId }, [
      emojiSegment,
    ]);
  } catch (err) {
    ctx.logger.warn(
      input.live
        ? `[Emoticon] Send failed: ${err}`
        : `[chat-runtime] Send emoji failed: ${err}`,
    );
  }
}

export interface SaveBotMessagesInput {
  target: ChatTarget;
  cfg: ChatConfig;
  bot: Bot | undefined;
  messages: string[];
  sentMessageIds?: Array<string | undefined>;
}

/** 机器人发言入库，供后续拉历史时合并 */
export function saveBotMessages(
  pluginCtx: Pick<ChatPluginContext, "ctx" | "db">,
  input: SaveBotMessagesInput,
): void {
  const { bot, cfg, target, messages, sentMessageIds } = input;
  if (!bot) {
    pluginCtx.ctx.logger.warn(`[saveBotMessages] bot ${target.selfId} not available`);
    return;
  }

  const timestamp = Date.now();
  const userName = cfg.nicknames[0] || bot.nickname || "Miku";
  for (let i = 0; i < messages.length; i++) {
    pluginCtx.db.saveMessage({
      sessionId: target.sessionId,
      role: "assistant",
      content: messages[i] ?? "",
      userId: String(bot.bot_id),
      userName,
      userRole: "member",
      groupId: target.groupId,
      timestamp,
      messageId: sentMessageIds?.[i],
    });
  }
}
