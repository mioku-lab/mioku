import type { AccessHook, PluginMetadata } from "mioku";

export interface AccessCandidate {
  plugin: string;
  command: string | null;
  event: string;
}

export function collectAccessHooks(
  plugins: PluginMetadata[],
): Map<string, AccessHook[]> {
  const map = new Map<string, AccessHook[]>();
  for (const p of plugins) {
    if (p.config?.accessHooks && p.config.accessHooks.length > 0) {
      map.set(p.name, p.config.accessHooks);
    }
  }
  return map;
}

function matchTextHook(text: string, hook: AccessHook): boolean {
  const m = String(hook.match || "").trim();
  if (!m) return false;
  if (m.startsWith("/") && m.endsWith("/") && m.length >= 3) {
    try {
      const re = new RegExp(m.slice(1, -1));
      return re.test(text);
    } catch {
      return false;
    }
  }
  return text === m || text.startsWith(m);
}

function matchEventHook(eventName: string, hook: AccessHook): boolean {
  const e = String(hook.event || "").trim();
  if (!e) return false;
  return eventName === e || eventName.startsWith(e + ".") || e.endsWith(".") && eventName.startsWith(e);
}

export function matchAll(
  eventName: string,
  text: string,
  hookMap: Map<string, AccessHook[]>,
): AccessCandidate[] {
  const out: AccessCandidate[] = [];
  const trimmed = String(text || "").trim();
  for (const [pluginName, hooks] of hookMap) {
    for (const hook of hooks) {
      if (hook.event) {
        if (!matchEventHook(eventName, hook)) continue;
        if (hook.match && trimmed && !matchTextHook(trimmed, hook)) continue;
        out.push({ plugin: pluginName, command: hook.id, event: eventName });
        continue;
      }
      if (!hook.match) continue;
      if (!trimmed) continue;
      if (matchTextHook(trimmed, hook)) {
        out.push({ plugin: pluginName, command: hook.id, event: eventName });
      }
    }
  }
  return out;
}
