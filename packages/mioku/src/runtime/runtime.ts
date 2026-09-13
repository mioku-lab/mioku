import fs from "node:fs";
import path from "node:path";
import { hrtime } from "node:process";

import { colors } from "consola/utils";

import {
  botConfig,
  reloadMiokuConfig,
  setBotCwd,
  updateMiokuConfig,
} from "../config";
import { createDefaultDriver, DriverShutdownError } from "../driver";
import type { Driver } from "../driver";
import { CapabilityRegistry } from "../adapter";
import { definePlugin } from "../plugin";
import type { MiokuPlugin, PluginCleanup } from "../plugin";
import { BotRegistry } from "./bots";
import { EventBus } from "./bus";
import { AdapterContextImpl } from "./context";
import type { RuntimeAdapterState } from "./context";
import { MiokuContext } from "./mioku-context";
import { EventCorrelator } from "./event-correlator";
import { CommandManager, setActiveCommandManager } from "./commands";
import { BUILTIN_PLUGINS as DEFAULT_BUILTIN_PLUGINS } from "../builtin";
import {
  createImportContext,
  discoverAdapterCandidates,
  discoverPluginCandidates,
  findLocalPlugins,
  loadAdapterDefinition,
  loadLocalPlugin,
  loadNpmPlugin,
} from "../loader";
import { buildPluginMetadata } from "../loader/manifest";
import { readPackageJsonSafe } from "../loader";
import {
  setPluginMetadata,
  removePluginMetadata,
  resetPluginMetadata,
} from "./plugin-metadata";

import type { Logger } from "../logger";
import type { Adapter, AdapterDefinition, BotLifecycleEvent } from "../adapter";
import type { PluginCandidate } from "../loader";
import type { Event } from "../adapter";
import type { Bot } from "../adapter";

export interface CreateRuntimeOptions {
  readonly cwd: string;
  readonly logger: Logger;
  readonly builtinPlugins?: readonly MiokuPlugin[];
  readonly driverFactory?: () => Driver;
  /** 去重选项；缺省开启 */
  readonly dedup?: {
    /** 跨适配器事件关联去重 */
    readonly crossAdapter?: boolean;
  };
}

export interface AdapterStartResult {
  readonly name: string;
  readonly adapter: Adapter;
}

const BUILTIN_PLUGINS: MiokuPlugin[] = [...DEFAULT_BUILTIN_PLUGINS];

export const setBuiltinPlugins = (plugins: readonly MiokuPlugin[]): void => {
  BUILTIN_PLUGINS.length = 0;
  BUILTIN_PLUGINS.push(...plugins);
};

export const getBuiltinPlugins = (): readonly MiokuPlugin[] => BUILTIN_PLUGINS;

export class MiokuRuntime {
  readonly #cwd: string;
  readonly #logger: Logger;
  readonly #bus: EventBus;
  readonly #bots: BotRegistry;
  readonly #capabilities: CapabilityRegistry;
  readonly #driver: Driver;
  readonly #adapterStates = new Map<string, RuntimeAdapterState>();
  readonly #enabledAdapters = new Map<string, AdapterDefinition<unknown>>();
  readonly #enabledPlugins = new Map<
    string,
    { cleanup: PluginCleanup | null; plugin: MiokuPlugin }
  >();
  readonly #driverFactory: () => Driver;
  readonly #builtinPlugins: readonly MiokuPlugin[];
  readonly #correlator: EventCorrelator | undefined;
  readonly #commands: CommandManager;
  #started = false;
  #stopped = false;

  constructor(options: CreateRuntimeOptions) {
    this.#cwd = path.resolve(options.cwd);
    this.#logger = options.logger;
    this.#driverFactory =
      options.driverFactory ?? (() => createDefaultDriver());
    this.#builtinPlugins = options.builtinPlugins ?? BUILTIN_PLUGINS;
    this.#correlator =
      options.dedup?.crossAdapter === false
        ? undefined
        : new EventCorrelator({ logger: this.#logger.child({ scope: "dedup" }) });
    this.#driver = this.#driverFactory();
    this.#bus = new EventBus();
    this.#bus.setLogger((level, message, detail) => {
      const fn = this.#logger[level] ?? this.#logger.error;
      if (detail === undefined) fn(message);
      else fn(message, detail);
    });
    this.#bots = new BotRegistry();
    this.#capabilities = new CapabilityRegistry();
    this.#commands = new CommandManager({
      getDefaultPrefix: () => String(botConfig.prefix ?? "."),
      getOwners: () => botConfig.owners,
      getAdmins: () => botConfig.admins,
      logger: this.#logger,
    });
    this.#bus.setFilter((registration, event) =>
      this.#commands.shouldDispatch(registration.source, event),
    );
    setActiveCommandManager(this.#commands);
  }

  get cwd(): string {
    return this.#cwd;
  }

  get logger(): Logger {
    return this.#logger;
  }

  get driver(): Driver {
    return this.#driver;
  }

  get bus(): EventBus {
    return this.#bus;
  }

  get commands(): CommandManager {
    return this.#commands;
  }

  /** 事件关联器（跨适配器去重）；为 undefined 时表示已禁用 */
  get correlator(): EventCorrelator | undefined {
    return this.#correlator;
  }

  get bots(): readonly Bot[] {
    return this.#bots.all();
  }

  get adapters(): readonly Adapter[] {
    return Array.from(this.#adapterStates.values())
      .map((state) => state.instance)
      .filter((a): a is Adapter => a != null);
  }

  getAdapter<T extends Adapter = Adapter>(name: string): T | undefined {
    const state = this.#adapterStates.get(name);
    return state?.instance as T | undefined;
  }

  pickBot<T extends Bot = Bot>(bot_id: string | number): T | undefined {
    return this.#bots.pick<T>(bot_id);
  }

  listPlugins(): Array<{
    name: string;
    type: "builtin" | "external";
    version?: string;
  }> {
    return Array.from(this.#enabledPlugins.entries()).map(([key, entry]) => {
      const colon = key.indexOf(":");
      const type = key.slice(0, colon);
      const name = key.slice(colon + 1);
      return {
        name,
        type: type === "builtin" ? "builtin" : "external",
        version: entry.plugin.version,
      };
    });
  }

  async enablePlugin(name: string): Promise<void> {
    const isEnabled =
      this.#enabledPlugins.has(`external:${name}`) ||
      this.#enabledPlugins.has(`builtin:${name}`);
    if (isEnabled) throw new Error(`插件 ${name} 已经是启用状态`);
    const appPkg = this.#readAppPackageJson();
    const jiti = createImportContext(this.#cwd);
    const local = findLocalPlugins(
      this.#cwd,
      botConfig.plugins_dir ?? "plugins",
    ).find((p) => p.name === name);
    if (local) {
      const pkg = readPackageJsonSafe(local.absPath) ?? {};
      const plugin = await loadLocalPlugin(jiti, name, local.absPath);
      await this.#loadPlugin(plugin, "external");
      setPluginMetadata(buildPluginMetadata(name, local.absPath, pkg));
      return;
    }
    const candidates = discoverPluginCandidates(this.#cwd, appPkg);
    const candidate = candidates.find((c) => c.name === name);
    if (candidate) {
      const plugin = await loadNpmPlugin(jiti, candidate);
      await this.#loadPlugin(plugin, "external");
      setPluginMetadata(
        buildPluginMetadata(
          candidate.name,
          candidate.resolvedPath,
          candidate.packageJson,
        ),
      );
      return;
    }
    throw new Error(`插件 ${name} 不存在`);
  }

  async disablePlugin(name: string): Promise<void> {
    const key = `external:${name}`;
    const entry = this.#enabledPlugins.get(key);
    if (!entry) {
      if (this.#enabledPlugins.has(`builtin:${name}`))
        throw new Error(`内置插件 ${name} 无法禁用`);
      throw new Error(`插件 ${name} 不存在或未启用`);
    }
    try {
      await entry.cleanup?.();
    } finally {
      this.#enabledPlugins.delete(key);
      removePluginMetadata(name);
    }
    this.#logger.info(`禁用插件 => ${name}`);
  }

  async reloadPlugin(name: string): Promise<void> {
    const wasExternal = this.#enabledPlugins.has(`external:${name}`);
    const wasBuiltin = this.#enabledPlugins.has(`builtin:${name}`);
    if (!wasExternal && !wasBuiltin) {
      await this.enablePlugin(name);
      return;
    }
    if (wasBuiltin) {
      const plugin = this.#builtinPlugins.find((p) => p.name === name);
      if (!plugin) throw new Error(`内置插件 ${name} 不存在`);
      await this.#enabledPlugins.get(`builtin:${name}`)?.cleanup?.();
      this.#enabledPlugins.delete(`builtin:${name}`);
      await this.#loadPlugin(plugin, "builtin");
      return;
    }
    await this.disablePlugin(name);
    await this.enablePlugin(name);
  }

  async #emitLifecycle(event: BotLifecycleEvent): Promise<void> {
    const lifecycleEvent: Event = {
      kind: "adapter",
      type: event.type,
      routes: [event.type],
      identity: {
        adapter: event.bot.adapter,
        bot_id: event.bot.bot_id,
        event_type: event.type,
      },
      bot: event.bot,
      self_id: event.bot.bot_id,
      time: Date.now(),
      raw: event,
      payload: event,
    };
    await this.#bus.dispatch(lifecycleEvent);
  }

  #createContext(state: RuntimeAdapterState): AdapterContextImpl {
    return new AdapterContextImpl({
      state,
      bots: this.#bots,
      bus: this.#bus,
      driver: this.#driver,
      capabilities: this.#capabilities,
      logger: this.#logger.child({ adapter: state.definition.name }),
      emit: (event) => this.#emitLifecycle(event),
      correlator: this.#correlator,
      commands: this.#commands,
    });
  }

  async #loadPlugin(
    plugin: MiokuPlugin,
    type: "builtin" | "external",
  ): Promise<void> {
    const cleanupTasks: PluginCleanup[] = [];
    const ctx = new MiokuContext({
      pluginName: `${type}:${plugin.name}`,
      pluginId: plugin.name === "mioku-core" ? "core" : plugin.name,
      commands: this.#commands,
      bus: this.#bus,
      bots: this.#bots,
      driver: this.#driver,
      capabilities: this.#capabilities,
      config: botConfig,
      logger: this.#logger.child({ plugin: plugin.name }),
      priority: plugin.priority ?? 100,
      correlator: this.#correlator,
      getAdapter: <T extends Adapter = Adapter>(name: string) =>
        this.getAdapter<T>(name),
      listAdapters: () => this.adapters,
      onUpdateConfig: async (updater) => {
        await updateMiokuConfig(updater);
      },
      pluginManager: {
        list: () => this.listPlugins(),
        localPlugins: () =>
          findLocalPlugins(this.#cwd, botConfig.plugins_dir ?? "plugins").map(
            (p) => p.name,
          ),
        enable: (name) => this.enablePlugin(name),
        disable: (name) => this.disablePlugin(name),
        reload: (name) => this.reloadPlugin(name),
      },
    });
    cleanupTasks.push(() => ctx.dispose());

    let cleanup: PluginCleanup | null = null;
    try {
      const result = await plugin.setup?.(ctx);
      cleanup = typeof result === "function" ? result : null;
    } catch (err) {
      await ctx.dispose();
      throw new Error(
        `Plugin "${plugin.name}" setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof cleanup === "function") cleanupTasks.push(cleanup);
    const wrappedCleanup: PluginCleanup = async () => {
      for (const fn of cleanupTasks) {
        try {
          await fn();
        } catch (err) {
          this.#logger.warn(
            `Plugin "${plugin.name}" cleanup error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    this.#enabledPlugins.set(`${type}:${plugin.name}`, {
      cleanup: wrappedCleanup,
      plugin,
    });
  }

  async #setupBuiltinPlugins(): Promise<void> {
    this.#logger.info(
      `>>> 加载内置插件: ${this.#builtinPlugins.map((p) => colors.cyan(p.name)).join(", ")}`,
    );
    for (const plugin of this.#builtinPlugins) {
      try {
        await this.#loadPlugin(plugin, "builtin");
      } catch (err) {
        this.#logger.error(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async #discoverAdapters(): Promise<void> {
    const appPkg = this.#readAppPackageJson();
    const candidates = discoverAdapterCandidates(this.#cwd, appPkg);
    const enabledNames = Object.keys(botConfig.adapters ?? {}) as string[];
    const candidateByName = new Map(
      candidates.map((candidate) => [candidate.name, candidate]),
    );
    const jiti = createImportContext(this.#cwd);
    for (const name of enabledNames) {
      const candidate = candidateByName.get(name);
      if (!candidate) {
        this.#logger.error(
          `适配器 "${name}" 已配置但未安装或不在项目直接依赖中，已跳过`,
        );
        continue;
      }
      try {
        const loaded = await loadAdapterDefinition(jiti, candidate);
        this.#enabledAdapters.set(name, loaded.definition);
      } catch (err) {
        this.#logger.error(
          `适配器 "${name}" 加载失败，已跳过: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  #readAppPackageJson(): import("../loader/package").PackageJson {
    const file = `${this.#cwd}/package.json`;
    if (!fs.existsSync(file)) {
      throw new Error(`无法在 ${this.#cwd} 下找到 package.json`);
    }
    return JSON.parse(
      fs.readFileSync(file, "utf-8"),
    ) as import("../loader/package").PackageJson;
  }

  async #setupPlugins(): Promise<void> {
    const startTime = hrtime.bigint();
    await this.#setupBuiltinPlugins();

    const appPkg = this.#readAppPackageJson();
    const enabledIds = new Set<string>(botConfig.plugins.map(String));
    if (enabledIds.size === 0) {
      await this.#logPluginSummary(startTime);
      return;
    }

    const candidates = discoverPluginCandidates(this.#cwd, appPkg);
    const candidateByName = new Map<string, PluginCandidate>(
      candidates.map((c) => [c.name, c]),
    );

    const localDir = botConfig.plugins_dir ?? "plugins";
    const localPlugins = findLocalPlugins(this.#cwd, localDir);

    const failed: Array<{ name: string; error: string }> = [];
    const jiti = createImportContext(this.#cwd);
    const tasks: Array<{
      name: string;
      priority: number;
      run: () => Promise<void>;
    }> = [];

    for (const id of enabledIds) {
      const npmCandidate = candidateByName.get(id);
      if (npmCandidate) {
        setPluginMetadata(
          buildPluginMetadata(
            npmCandidate.name,
            npmCandidate.resolvedPath,
            npmCandidate.packageJson,
          ),
        );
        try {
          const plugin = await loadNpmPlugin(jiti, npmCandidate);
          tasks.push({
            name: id,
            priority: plugin.priority ?? npmCandidate.priority ?? 100,
            run: async () => {
              await this.#loadPlugin(plugin, "external");
            },
          });
        } catch (err) {
          failed.push({
            name: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      const local = localPlugins.find((p) => p.name === id);
      if (!local) {
        failed.push({
          name: id,
          error: `插件 "${id}" 未找到（既不在依赖中，也不在本地插件目录中）`,
        });
        continue;
      }
      setPluginMetadata(
        buildPluginMetadata(
          id,
          local.absPath,
          readPackageJsonSafe(local.absPath) ?? {},
        ),
      );
      try {
        const plugin = await loadLocalPlugin(jiti, id, local.absPath);
        tasks.push({
          name: id,
          priority: plugin.priority ?? 100,
          run: async () => {
            await this.#loadPlugin(plugin, "external");
          },
        });
      } catch (err) {
        failed.push({
          name: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const priorityGroups = new Map<number, typeof tasks>();
    for (const task of tasks) {
      const group = priorityGroups.get(task.priority) ?? [];
      group.push(task);
      priorityGroups.set(task.priority, group);
    }
    const priorities = Array.from(priorityGroups.keys()).sort((a, b) => a - b);
    if (priorities.length > 0) {
      this.#logger.info(
        `>>> 加载用户插件: ${priorities
          .map(
            (priority) =>
              `优先级 ${colors.yellow(priority)} (${(priorityGroups.get(priority) ?? []).map((t) => colors.cyan(t.name)).join(", ")})`,
          )
          .join("，")}`,
      );
    }
    for (const priority of priorities) {
      const group = priorityGroups.get(priority) ?? [];
      await Promise.allSettled(group.map((t) => t.run()));
    }

    if (failed.length > 0) {
      const summary = failed.map((f) => `  - ${f.name}: ${f.error}`).join("\n");
      this.#logger.warn(`以下插件加载失败:\n${summary}`);
      for (const f of failed) removePluginMetadata(f.name);
    }

    await this.#logPluginSummary(startTime);
  }

  async #logPluginSummary(startTime: bigint): Promise<void> {
    const end = hrtime.bigint();
    const cost = Math.round(Number(end - startTime)) / 1_000_000;
    const enabledCount = this.#enabledPlugins.size;
    this.#logger.info(
      `成功加载了 ${colors.green(enabledCount)} 个插件，总耗时 ${colors.green(cost.toFixed(2))} 毫秒`,
    );
  }

  async #startAdapter(name: string): Promise<Adapter> {
    const definition = this.#enabledAdapters.get(name);
    if (!definition) {
      throw new Error(`Adapter "${name}" is not enabled`);
    }
    const rawConfig = (botConfig.adapters ?? {})[name];
    let config: unknown = rawConfig;
    if (definition.validateConfig) {
      try {
        config = definition.validateConfig(rawConfig);
      } catch (err) {
        throw new Error(
          `Adapter "${name}" config validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const state: RuntimeAdapterState = {
      definition,
      instance: null,
      context: null,
      gateways: [],
      resources: [],
      started: false,
    };
    this.#adapterStates.set(name, state);
    const context = this.#createContext(state);
    state.context = context;
    const adapterLogger = this.#logger.child({ adapter: name });
    let instance: Adapter;
    try {
      const result = definition.create({ config, logger: adapterLogger });
      instance = result instanceof Promise ? await result : result;
    } catch (err) {
      this.#adapterStates.delete(name);
      throw new Error(
        `Adapter "${name}" failed to construct: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    state.instance = instance;
    try {
      await instance.start(context);
      await context.waitForStarts();
      state.started = true;
    } catch (err) {
      state.started = false;
      this.#adapterStates.delete(name);
      try {
        await instance.stop("startup failed");
      } catch {
        // ignore
      }
      throw new Error(
        `Adapter "${name}" failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return instance;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Runtime already started");
    }
    this.#started = true;
    await this.#discoverAdapters();
    await this.#setupPlugins();
    const adapterNames = Array.from(this.#enabledAdapters.keys());
    const failed: string[] = [];
    for (const name of adapterNames) {
      try {
        const adapter = await this.#startAdapter(name);
        await this.#bus.dispatch({
          kind: "adapter",
          type: "adapter:started",
          routes: ["adapter:started"],
          identity: { adapter: name, event_type: "adapter:started" },
          time: Date.now(),
          payload: { name },
        });
      } catch (err) {
        this.#logger.error(
          `适配器 "${name}" 启动失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      this.#logger.warn(
        `以下适配器启动失败，框架将继续运行: ${failed.join(", ")}`,
      );
    }
    await this.#bus.dispatch({
      kind: "adapter",
      type: "runtime:ready",
      routes: ["runtime:ready"],
      identity: { adapter: "" as string, event_type: "runtime:ready" },
      time: Date.now(),
      payload: undefined,
    });
  }

  async shutdown(reason?: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#bus.dispatch({
      kind: "adapter",
      type: "runtime:shutdown",
      routes: ["runtime:shutdown"],
      identity: { adapter: "" as string, event_type: "runtime:shutdown" },
      time: Date.now(),
      payload: reason ? { reason } : undefined,
    });
    const adapters = Array.from(this.#adapterStates.values());
    for (let i = adapters.length - 1; i >= 0; i--) {
      const state = adapters[i];
      if (!state.instance) continue;
      try {
        await state.instance.stop(reason ?? "shutdown");
      } catch (err) {
        this.#logger.warn(
          `Adapter "${state.definition.name}" stop failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (state.resources) {
        for (let r = state.resources.length - 1; r >= 0; r--) {
          try {
            await state.resources[r].dispose(reason ?? "shutdown");
          } catch (err) {
            this.#logger.warn(
              `Resource "${state.resources[r].name}" dispose failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        state.resources.length = 0;
      }
      if (state.gateways) {
        for (let g = state.gateways.length - 1; g >= 0; g--) {
          try {
            await state.gateways[g].stop(reason ?? "shutdown");
          } catch (err) {
            this.#logger.warn(
              `Gateway "${state.gateways[g].name}" stop failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        state.gateways.length = 0;
      }
    }
    for (const [, entry] of this.#enabledPlugins) {
      try {
        await entry.cleanup?.();
      } catch (err) {
        this.#logger.warn(
          `Plugin cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.#enabledPlugins.clear();
    this.#capabilities.clear();
    this.#bots.clear();
    this.#correlator?.clear();
    this.#commands.clear();
    setActiveCommandManager(undefined);
    resetPluginMetadata();
    try {
      await this.#driver.shutdown();
    } catch (err) {
      if (!(err instanceof DriverShutdownError)) {
        this.#logger.warn(
          `Driver shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

export const createRuntime = (options: CreateRuntimeOptions): MiokuRuntime => {
  setBotCwd(options.cwd);
  reloadMiokuConfig();
  return new MiokuRuntime(options);
};

export { definePlugin };
