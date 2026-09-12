import { AdapterRegistrationConflictError } from "./context";
import { connectedBotKey, connectedBots } from "../compat/connected-bots";

import type { Bot, BotContext } from "../adapter";

/** Bot 注册表：登记已连接的 bot，按 bot_id 查询 */
export class BotRegistry {
  #bots = new Map<string, { adapter: string; bot_id: string; bot: Bot }>();
  #disposers = new Map<string, () => void>();

  /** 登记一个 bot，返回可注销的上下文 */
  register(bot: Bot): BotContext {
    const key = connectedBotKey(bot.adapter, bot.bot_id);
    if (this.#bots.has(key)) {
      throw new AdapterRegistrationConflictError(key);
    }
    this.#bots.set(key, { adapter: bot.adapter, bot_id: bot.bot_id, bot });
    connectedBots.set(key, bot);
    const dispose = (): void => {
      this.unregister(bot.bot_id, bot.adapter);
    };
    this.#disposers.set(key, dispose);
    return {
      bot,
      unregister: dispose,
    };
  }

  has(key: string): boolean {
    return this.#bots.has(key);
  }

  unregister(bot_id: string, adapter: string): boolean {
    const key = connectedBotKey(adapter, bot_id);
    const removed = this.#bots.delete(key);
    this.#disposers.delete(key);
    connectedBots.delete(key);
    return removed;
  }

  /** 按 bot_id 取 bot（只按 id 匹配，不限适配器） */
  pick<T extends Bot = Bot>(bot_id: string | number): T | undefined {
    const key = String(bot_id);
    for (const entry of this.#bots.values()) {
      if (entry.bot_id === key) return entry.bot as T;
    }
    return undefined;
  }

  find<T extends Bot = Bot>(adapter: string, bot_id: string): T | undefined {
    return this.#bots.get(connectedBotKey(adapter, bot_id))?.bot as
      | T
      | undefined;
  }

  all<T extends Bot = Bot>(): readonly T[] {
    return Array.from(this.#bots.values()).map((entry) => entry.bot as T);
  }

  size(): number {
    return this.#bots.size;
  }

  clear(): void {
    this.#bots.clear();
    this.#disposers.clear();
    connectedBots.clear();
  }
}
