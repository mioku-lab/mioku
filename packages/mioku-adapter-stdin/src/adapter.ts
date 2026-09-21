import { createInterface, type Interface } from "node:readline";

import {
  bindCapabilities,
  buildRoutes,
  createFriendRef,
  createMessage,
  defineAdapter,
  messageSend,
  registerStatusProvider,
  segment,
  type Adapter,
  type AdapterContext,
  type AdapterFactoryOptions,
  type EventIdentity,
  type MessageEvent,
  type SenderInfo,
} from "mioku";

import { createStdinBot, type StdinBot } from "./bot";
import { normalizeConfig, type StdinAdapterConfig } from "./config";
import { version as adapterVersion } from "../package.json" with { type: "json" };

const NAME = "stdin" as const;
const BOT_ID = "stdin";
const USER_ID = "stdin";

type BotCounters = { send: number; receive: number };

const build = (
  config: StdinAdapterConfig,
  logger: import("mioku").Logger,
): Adapter => {
  const prompt = config.prompt ?? "mioku> ";
  const nickname = config.nickname ?? "stdin";
  const counters: BotCounters = { send: 0, receive: 0 };

  let context: AdapterContext | undefined;
  let rl: Interface | undefined;
  let bot: StdinBot | undefined;
  let unregisterBot: (() => void) | undefined;
  let unregisterCapabilities: Array<() => void> = [];
  let unregisterStatus: (() => void) | undefined;
  let data = {
    bot_id: BOT_ID,
    adapter: NAME,
    nickname,
    online: false,
    connected_at: undefined as number | undefined,
  };
  let eventSeq = 0;

  const buildMessageEvent = (line: string): MessageEvent => {
    const id = `stdin:${++eventSeq}:${Date.now()}`;
    const identity: EventIdentity = {
      adapter: NAME,
      bot_id: BOT_ID,
      event_type: "message.private",
      message_id: id,
      timestamp: Date.now(),
    };
    const sender: SenderInfo = {
      user_id: USER_ID,
      nickname: "stdin",
      role: "owner",
    };
    const currentBot = bot!;
    return {
      kind: "message",
      type: "message",
      routes: buildRoutes(NAME, "message", "private"),
      identity,
      self_id: BOT_ID,
      bot: currentBot,
      time: Date.now(),
      raw: { line },
      message_type: "private",
      user_id: USER_ID,
      message_id: id,
      raw_message: line,
      sender,
      friend: createFriendRef(currentBot, USER_ID, "stdin"),
      message: createMessage([segment.text(line)], line),
      is_to_me: true,
      reply: async (input, _options) =>
        currentBot.sendMessage({ type: "private", user_id: USER_ID }, input),
      recall: async () => {
        // 终端输出没有“撤回”语义，静默忽略
      },
    };
  };

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (!text) {
      if (process.stdin.isTTY && rl) rl.prompt();
      return;
    }
    counters.receive++;
    if (bot && context) {
      try {
        await context.dispatch(buildMessageEvent(text));
      } catch (err) {
        logger.error(
          `stdin 消息处理失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (process.stdin.isTTY && rl) rl.prompt();
  };

  const handleClose = async (): Promise<void> => {
    if (data.online) {
      data.online = false;
      if (bot && context)
        await context.emitLifecycle({ type: "bot:disconnected", bot });
    }
    logger.info("stdin 输入流已关闭");
    if (config.exit_on_eof) {
      process.exit(0);
    }
  };

  return {
    name: NAME,
    version: adapterVersion,
    async start(next) {
      context = next;
      bot = bindCapabilities(
        createStdinBot(data, () => counters.send++),
        context.getCapabilityRegistry(),
      );
      unregisterBot = context.registerBot(bot).unregister;
      unregisterCapabilities = [
        context.registerCapability(
          messageSend,
          { adapter: NAME, bot_id: BOT_ID },
          (req) => bot!.sendMessage(req.target, req.message),
        ),
      ];
      unregisterStatus = registerStatusProvider(
        { adapter: NAME, bot_id: BOT_ID },
        async () => ({
          adapter: NAME,
          bot_id: BOT_ID,
          stats: { sent: counters.send, received: counters.receive },
          data: {},
        }),
      );

      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY ?? false,
      });
      if (process.stdin.isTTY) rl.setPrompt(prompt);
      rl.on("line", (line) => void handleLine(line));
      rl.on("close", () => void handleClose());

      data.online = true;
      data.connected_at = Date.now();
      if (bot) await context.emitLifecycle({ type: "bot:connected", bot });
      logger.info(`stdin 适配器已就绪，直接在终端输入命令即可`);
      if (process.stdin.isTTY) rl.prompt();
    },
    async stop(reason) {
      if (data.online) {
        data.online = false;
        if (bot && context)
          await context.emitLifecycle({
            type: "bot:disconnected",
            bot,
            reason,
          });
      }
      try {
        rl?.close();
      } catch {
        // ignore
      }
      rl = undefined;
      unregisterStatus?.();
      unregisterStatus = undefined;
      for (const dispose of unregisterCapabilities) dispose();
      unregisterCapabilities = [];
      unregisterBot?.();
      unregisterBot = undefined;
      bot = undefined;
    },
  };
};

export const stdinAdapterDefinition = defineAdapter<StdinAdapterConfig>({
  name: NAME,
  version: adapterVersion,
  apiVersion: 1,
  validateConfig: (input) => normalizeConfig(input),
  create: (options: AdapterFactoryOptions<StdinAdapterConfig>) =>
    build(options.config, options.logger),
});

export { messageSend };
