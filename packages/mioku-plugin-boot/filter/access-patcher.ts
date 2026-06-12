import { type MiokiContext, pluginManager } from "mioku";
import type { AccessControlConfig } from "mioku";
import { resolveAccessForCandidates } from "./access-rules";
import { collectAccessHooks, matchAll } from "./matcher-registry";
import { isAccessControlledEventName } from "./message-filter";

export function shouldAllow(
  event: any,
  eventName: string,
  text: string,
  rules: AccessControlConfig,
): boolean {
  const hookMap = collectAccessHooks(pluginManager.getAllMetadata());
  const candidates = matchAll(eventName, text, hookMap);
  if (candidates.length === 0) return true;
  return resolveAccessForCandidates(rules, event, eventName, candidates) === "allow";
}

export function createAccessControlPatcher(
  ctx: MiokiContext,
  getRules: () => AccessControlConfig,
): () => void {
  const patchedBots: Array<{ bot: any; on: any; once: any }> = [];

  for (const bot of ctx.bots || []) {
    if (!bot || typeof bot.on !== "function") continue;

    const originalOn = bot.on.bind(bot);
    const originalOnce =
      typeof bot.once === "function" ? bot.once.bind(bot) : undefined;

    const wrap = (original: any) => (eventName: any, handler: any) => {
      if (!isAccessControlledEventName(eventName) || typeof handler !== "function") {
        return original(eventName, handler);
      }
      return original(eventName, (event: any) => {
        const text = String(ctx.text?.(event) ?? event?.raw_message ?? "").trim();
        if (!shouldAllow(event, String(eventName), text, getRules())) {
          return;
        }
        return handler(event);
      });
    };

    bot.on = wrap(originalOn);

    if (originalOnce) {
      bot.once = wrap(originalOnce);
    }

    patchedBots.push({ bot, on: originalOn, once: originalOnce });
  }

  return () => {
    for (const item of patchedBots) {
      item.bot.on = item.on;
      if (item.once) item.bot.once = item.once;
    }
  };
}
