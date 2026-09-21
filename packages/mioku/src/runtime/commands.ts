import type { Event, MessageEvent } from "../adapter";
import type {
  AccessControlConfig,
  CommandRole,
  PluginHelp,
  PluginMetadata,
} from "../types";
import type { MiokuContext } from "./mioku-context";
import { isEventGroupAdmin, isEventGroupOwner, toUserId } from "./permissions";

export type CommandMatcher = string | RegExp;

export interface CommandExecutionContext {
  readonly ctx: MiokuContext;
  readonly event: MessageEvent;
  readonly command: RegisteredCommand;
  readonly text: string;
  readonly body: string;
  readonly args: readonly string[];
  readonly match?: RegExpMatchArray;
}

export type CommandHandler = (
  context: CommandExecutionContext,
) => void | Promise<void>;

export interface CommandDefinition {
  readonly id?: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly match?: CommandMatcher;
  readonly description?: string;
  readonly usage?: string;
  readonly permission?: CommandRole;
  readonly priority?: number;
  readonly prefixes?: string | readonly string[] | false;
  readonly handler: CommandHandler;
}

export interface CommandShortcutOptions extends Omit<
  CommandDefinition,
  "name" | "match" | "handler"
> {
  readonly id?: string;
  readonly name?: string;
}

export interface RegisteredCommand {
  readonly plugin: string;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly matcher: CommandMatcher;
  readonly description: string;
  readonly usage?: string;
  readonly permission: CommandRole;
  readonly priority: number;
  readonly prefixes?: string | readonly string[] | false;
  readonly handler: CommandHandler;
  readonly order: number;
}

export interface CommandCatalogItem {
  readonly kind: "plugin" | "command";
  readonly plugin: string;
  readonly id: string;
  readonly label: string;
  readonly desc?: string;
  readonly usage?: string;
  readonly permission?: CommandRole;
  readonly priority?: number;
  readonly match?: string;
  readonly event?: string;
  readonly source: "runtime" | "manifest";
}

interface LegacyPlugin {
  readonly metadata: PluginMetadata;
}

interface StoredCommand extends RegisteredCommand {
  readonly context: MiokuContext;
}

interface CommandMatch {
  readonly command: StoredCommand;
  readonly body: string;
  readonly args: string[];
  readonly match?: RegExpMatchArray;
}

const normalizeRole = (role: unknown): CommandRole => {
  const value = String(role ?? "member")
    .trim()
    .toLowerCase();
  if (value === "master" || value === "owner" || value === "admin") {
    return value as CommandRole;
  }
  return "member";
};

const userIdOf = (event: MessageEvent): string | undefined => toUserId(event);

const textHookMatches = (text: string, raw: string | undefined): boolean => {
  const source = String(raw ?? "").trim();
  if (!source) return false;
  if (source.startsWith("/") && source.length > 1) {
    const end = source.lastIndexOf("/");
    if (end > 0) {
      try {
        const flags = source.slice(end + 1);
        const regex = new RegExp(source.slice(1, end), flags);
        return regex.test(text);
      } catch {
        return false;
      }
    }
  }
  return text === source || text.startsWith(source);
};

const routeMatches = (event: Event, route: string | undefined): boolean => {
  if (!route) return false;
  return event.type === route || event.routes.some((item) => item === route);
};

const parsePrefixes = (
  prefixes: string | readonly string[] | false,
  defaultPrefix: string,
): readonly string[] => {
  if (prefixes === false) return ["", defaultPrefix];
  const values = Array.isArray(prefixes) ? prefixes : [prefixes];
  const normalized = values
    .map((value) => String(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  return normalized.length > 0 ? normalized : [defaultPrefix];
};

const commandBody = (
  text: string,
  prefixes: readonly string[],
): string | undefined => {
  const prefix = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .find((item) => item === "" || text.startsWith(item));
  if (prefix === undefined) return undefined;
  return text.slice(prefix.length).trimStart();
};

const stringMatch = (
  body: string,
  matcher: string,
): { args: string[] } | undefined => {
  const value = matcher.trim();
  if (!value) return undefined;
  if (
    body !== value &&
    !(body.startsWith(value) && /\s/.test(body[value.length] ?? ""))
  ) {
    return undefined;
  }
  const rest = body.slice(value.length).trim();
  return { args: rest ? rest.split(/\s+/) : [] };
};

const commandKey = (value: string): string =>
  String(value)
    .trim()
    .replace(/^[#/.]+\s*/, "")
    .split(/\s+/)[0]
    .toLowerCase();

const displayCommand = (
  command: RegisteredCommand,
  defaultPrefix: string,
): string => {
  if (command.prefixes === false) return command.name;
  const prefixes =
    command.prefixes === undefined
      ? [defaultPrefix]
      : Array.isArray(command.prefixes)
        ? command.prefixes
        : [command.prefixes];
  return `${prefixes.find((prefix) => prefix.length > 0) ?? ""}${command.name}`;
};

export class CommandManager {
  readonly #getDefaultPrefix: () => string;
  readonly #getOwners: () => readonly string[];
  readonly #getAdmins: () => readonly string[];
  readonly #logger?: { error(message: string, detail?: unknown): void };
  readonly #commands: StoredCommand[] = [];
  readonly #legacy = new Map<string, LegacyPlugin>();
  #access: AccessControlConfig | undefined;
  #nextOrder = 0;

  constructor(options: {
    getDefaultPrefix: () => string;
    getOwners: () => readonly string[];
    getAdmins: () => readonly string[];
    logger?: { error(message: string, detail?: unknown): void };
  }) {
    this.#getDefaultPrefix = options.getDefaultPrefix;
    this.#getOwners = options.getOwners;
    this.#getAdmins = options.getAdmins;
    this.#logger = options.logger;
  }

  register(
    plugin: string,
    definition: CommandDefinition,
    context: MiokuContext,
  ): () => void;
  register(
    plugin: string,
    matcher: CommandMatcher,
    handler: CommandHandler,
    options?: CommandShortcutOptions,
    context?: MiokuContext,
  ): () => void;
  register(
    plugin: string,
    definitionOrMatcher: CommandDefinition | CommandMatcher,
    handlerOrContext?: CommandHandler | MiokuContext,
    optionsOrContext: CommandShortcutOptions | MiokuContext = {},
    context?: MiokuContext,
  ): () => void {
    const isDefinition =
      typeof definitionOrMatcher === "object" &&
      definitionOrMatcher !== null &&
      "name" in definitionOrMatcher;
    const shortcutOptions = isDefinition
      ? {}
      : (optionsOrContext as CommandShortcutOptions);
    const resolvedContext = isDefinition
      ? (handlerOrContext as MiokuContext | undefined)
      : context;
    const handler = isDefinition
      ? undefined
      : (handlerOrContext as CommandHandler | undefined);
    const definition: CommandDefinition = isDefinition
      ? definitionOrMatcher
      : {
          ...shortcutOptions,
          name: shortcutOptions.name ?? String(definitionOrMatcher),
          match: definitionOrMatcher as CommandMatcher,
          handler: handler as CommandHandler,
        };
    if (typeof definition.handler !== "function") {
      throw new Error("CommandManager.register: handler must be a function");
    }
    if (!resolvedContext)
      throw new Error("CommandManager.register: context is required");
    const name = String(definition.name ?? "").trim();
    if (!name) throw new Error("CommandManager.register: name is required");
    const matcher = definition.match ?? name;
    const command: StoredCommand = {
      plugin,
      id: String(definition.id ?? name).trim() || name,
      name,
      aliases: (definition.aliases ?? [])
        .map((item) => String(item).trim())
        .filter(Boolean),
      matcher,
      description: String(definition.description ?? "").trim(),
      usage: definition.usage,
      permission: normalizeRole(definition.permission),
      priority:
        typeof definition.priority === "number" &&
        !Number.isNaN(definition.priority)
          ? definition.priority
          : 0,
      prefixes: definition.prefixes,
      handler: definition.handler,
      order: this.#nextOrder++,
      context: resolvedContext,
    };
    this.#commands.push(command);
    return () => {
      const index = this.#commands.indexOf(command);
      if (index >= 0) this.#commands.splice(index, 1);
    };
  }

  setAccessControl(config: AccessControlConfig | undefined): void {
    this.#access = config;
  }

  syncMetadata(metadata: PluginMetadata): void {
    this.#legacy.set(metadata.name, { metadata });
  }

  removePlugin(plugin: string): void {
    this.#legacy.delete(plugin);
    for (let i = this.#commands.length - 1; i >= 0; i--) {
      if (this.#commands[i].plugin === plugin) this.#commands.splice(i, 1);
    }
  }

  clear(): void {
    this.#commands.length = 0;
    this.#legacy.clear();
    this.#access = undefined;
  }

  list(): readonly RegisteredCommand[] {
    return this.#orderedCommands();
  }

  #orderedCommands(): StoredCommand[] {
    return [...this.#commands].sort(
      (a, b) => a.priority - b.priority || a.order - b.order,
    );
  }

  getPluginHelp(plugin: string): PluginHelp | undefined {
    const metadata = this.#legacy.get(plugin)?.metadata;
    const runtime = this.#commands.filter((item) => item.plugin === plugin);
    if (!metadata?.config.help && runtime.length === 0) return undefined;
    const commands: PluginHelp["commands"] = [];
    const seen = new Set<string>();
    const runtimeByKey = new Map(
      runtime.map((command) => [commandKey(command.name), command]),
    );
    for (const command of metadata?.config.help?.commands ?? []) {
      const key = commandKey(command.cmd);
      const runtimeCommand = runtimeByKey.get(key);
      if (runtimeCommand) {
        const cmd = displayCommand(runtimeCommand, this.#getDefaultPrefix());
        seen.add(key);
        commands.push({
          cmd,
          desc: runtimeCommand.description || command.desc || cmd,
          usage: runtimeCommand.usage ?? command.usage,
          role: runtimeCommand.permission,
        });
      } else if (!seen.has(key)) {
        seen.add(key);
        commands.push(command);
      }
    }
    for (const command of runtime) {
      const cmd = displayCommand(command, this.#getDefaultPrefix());
      if (seen.has(commandKey(cmd))) continue;
      seen.add(commandKey(cmd));
      commands.push({
        cmd,
        desc: command.description || cmd,
        usage: command.usage,
        role: command.permission,
      });
    }
    const help = metadata?.config.help;
    return {
      title: help?.title || plugin,
      description: help?.description || metadata?.description || "",
      commands,
    };
  }

  catalog(): CommandCatalogItem[] {
    const items: CommandCatalogItem[] = [];
    const plugins = new Set<string>([
      ...this.#legacy.keys(),
      ...this.#commands.map((item) => item.plugin),
    ]);
    for (const plugin of plugins) {
      const metadata = this.#legacy.get(plugin)?.metadata;
      const help = metadata?.config.help;
      items.push({
        kind: "plugin",
        plugin,
        id: plugin,
        label: help?.title || plugin,
        desc: help?.description || metadata?.description,
        source: metadata ? "manifest" : "runtime",
      });
      const seen = new Set<string>();
      for (const command of this.#commands.filter(
        (item) => item.plugin === plugin,
      )) {
        seen.add(commandKey(command.id));
        items.push({
          kind: "command",
          plugin,
          id: command.id,
          label: command.name,
          desc: command.description,
          usage: command.usage,
          permission: command.permission,
          priority: command.priority,
          match:
            command.matcher instanceof RegExp
              ? command.matcher.toString()
              : command.matcher,
          source: "runtime",
        });
      }
      for (const hook of metadata?.config.accessHooks ?? []) {
        if (seen.has(commandKey(hook.id))) continue;
        seen.add(commandKey(hook.id));
        items.push({
          kind: "command",
          plugin,
          id: hook.id,
          label: hook.id,
          desc: hook.description,
          match: hook.match,
          event: hook.event,
          source: "manifest",
        });
      }
      for (const command of help?.commands ?? []) {
        if (seen.has(commandKey(command.cmd))) continue;
        seen.add(commandKey(command.cmd));
        items.push({
          kind: "command",
          plugin,
          id: command.cmd,
          label: command.cmd,
          desc: command.desc,
          usage: command.usage,
          permission: command.role,
          source: "manifest",
        });
      }
    }
    return items.sort((a, b) =>
      a.kind === b.kind
        ? a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id)
        : a.kind === "plugin"
          ? -1
          : 1,
    );
  }

  async dispatch(event: MessageEvent): Promise<boolean> {
    const text = String(event.message?.text?.() ?? "").trim();
    if (!text) return false;
    const match = this.#find(text);
    if (!match) return false;
    if (!this.#canUse(match.command, event)) return true;
    try {
      await match.command.handler({
        ctx: match.command.context,
        event,
        command: match.command,
        text,
        body: match.body,
        args: match.args,
        match: match.match,
      });
    } catch (error) {
      this.#logger?.error(
        `Command "${match.command.plugin}:${match.command.id}" failed`,
        error,
      );
    }
    return true;
  }

  shouldDispatch(source: string, event: Event): boolean {
    if (!source.startsWith("plugin:")) return true;
    const plugin = source.slice("plugin:".length);
    const metadata = this.#legacy.get(plugin)?.metadata;
    if (!metadata) return this.#pluginAllowed(plugin, event);
    if (!this.#pluginAllowed(plugin, event)) return false;
    const text =
      event.kind === "message" ? String(event.message.text()).trim() : "";
    const matches = (metadata.config.accessHooks ?? []).filter(
      (hook) =>
        (event.kind === "message" && textHookMatches(text, hook.match)) ||
        routeMatches(event, hook.event),
    );
    return matches.every((hook) =>
      this.#commandAllowed(plugin, hook.id, event),
    );
  }

  #find(text: string): CommandMatch | undefined {
    for (const command of this.#orderedCommands()) {
      const prefixes = parsePrefixes(
        command.prefixes ?? this.#getDefaultPrefix(),
        this.#getDefaultPrefix(),
      );
      const body = commandBody(text, prefixes);
      if (body === undefined) continue;
      if (typeof command.matcher === "string") {
        const candidates = [command.matcher, command.name, ...command.aliases];
        for (const candidate of candidates) {
          const result = stringMatch(body, candidate);
          if (result) return { command, body, args: result.args };
        }
        continue;
      }
      command.matcher.lastIndex = 0;
      const matched = body.match(command.matcher);
      if (!matched) continue;
      const args =
        matched.length > 1
          ? matched.slice(1).filter((item): item is string => item != null)
          : body.slice(matched[0].length).trim().split(/\s+/).filter(Boolean);
      return { command, body, args, match: matched };
    }
    return undefined;
  }

  #canUse(command: RegisteredCommand, event: MessageEvent): boolean {
    const userId = userIdOf(event);
    const master = Boolean(userId && this.#isMaster(userId));
    const owner = master || this.#isGroupOwner(event);
    const admin =
      owner ||
      Boolean(userId && this.#isAdmin(userId)) ||
      this.#isGroupAdmin(event);
    if (command.permission === "master") {
      if (!master) return false;
    } else if (command.permission === "owner") {
      if (!owner) return false;
    } else if (command.permission === "admin" && !admin) {
      return false;
    }
    return this.#commandAllowed(command.plugin, command.id, event);
  }

  #pluginAllowed(plugin: string, event: Event): boolean {
    const userId =
      event.kind === "message"
        ? userIdOf(event)
        : "user_id" in event
          ? event.user_id
          : undefined;
    if (
      (userId && (this.#isMaster(userId) || this.#isAdmin(userId))) ||
      this.#isGroupOwner(event) ||
      this.#isGroupAdmin(event)
    )
      return true;
    return this.#resolveAction(plugin, undefined, event) !== "block";
  }

  #commandAllowed(plugin: string, command: string, event: Event): boolean {
    const userId =
      event.kind === "message"
        ? userIdOf(event)
        : "user_id" in event
          ? event.user_id
          : undefined;
    if (
      (userId && (this.#isMaster(userId) || this.#isAdmin(userId))) ||
      this.#isGroupOwner(event) ||
      this.#isGroupAdmin(event)
    )
      return true;
    return this.#resolveAction(plugin, command, event) !== "block";
  }

  #resolveAction(
    plugin: string,
    command: string | undefined,
    event: Event,
  ): "allow" | "block" | undefined {
    const access = this.#access;
    if (!access) return undefined;
    const scopes = [
      (() => {
        const userId =
          event.kind === "message"
            ? userIdOf(event)
            : "user_id" in event && event.user_id
              ? String(event.user_id)
              : undefined;
        return userId ? access.users[userId] : undefined;
      })(),
      (() => {
        const groupId =
          "group_id" in event && event.group_id
            ? String(event.group_id)
            : undefined;
        return groupId ? access.groups[groupId] : undefined;
      })(),
      access.global,
    ];
    for (const scope of scopes) {
      if (!scope) continue;
      const commandRule = command
        ? scope.commands?.[plugin]?.[command]?.action
        : undefined;
      if (commandRule) return commandRule;
      const pluginRule = scope.plugins?.[plugin]?.action;
      if (pluginRule) return pluginRule;
    }
    return undefined;
  }

  #isMaster(userId: string): boolean {
    return this.#owners().includes(userId);
  }

  #isAdmin(userId: string): boolean {
    return this.#isMaster(userId) || this.#admins().includes(userId);
  }

  #isGroupOwner(event: Event): boolean {
    return isEventGroupOwner(event);
  }

  #isGroupAdmin(event: Event): boolean {
    return isEventGroupAdmin(event);
  }

  #owners(): string[] {
    return this.#configIds("owners");
  }

  #admins(): string[] {
    return this.#configIds("admins");
  }

  #configIds(key: "owners" | "admins"): string[] {
    return [...(key === "owners" ? this.#getOwners() : this.#getAdmins())].map(
      String,
    );
  }
}

let activeCommandManager: CommandManager | undefined;

export const setActiveCommandManager = (
  manager: CommandManager | undefined,
): void => {
  activeCommandManager = manager;
};

export const getActiveCommandManager = (): CommandManager | undefined =>
  activeCommandManager;
