# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`mioku` is a convenience layer on top of [mioki](https://mioki.viki.moe/) — a QQ bot framework that connects to a OneBot v11 / NapCat implementation. mioku adds a service-oriented architecture, an AI Skill system, declarative config and help registration, and a CLI/webUI for project bootstrap. It is distributed as a bun workspace monorepo.

End users get a project scaffolded by `npx mioku` whose entry point is one line: `import { start } from "mioku"; start({ cwd: import.meta.dirname })`. Everything else — plugins, services, config, WebUI — is discovered and wired by that `start()` call.

## Workspace layout

Bun workspaces (declared in root `package.json`, **not** `pnpm-workspace.yaml` — that file is stale leftovers and should be ignored):

```
packages/
  mioku/                  # the framework package (builds to dist/, exports the `mioku` bin)
    src/
      index.ts            # public API + start()
      cli.ts              # `npx mioku` CLI (scaffold, install, update)
      core/
        plugin-manager.ts     # scans plugins/ + node_modules for mioku-plugin-*
        service-manager.ts    # scans services/ + node_modules for mioku-service-*
        plugin-linker.ts      # creates symlinks in .mioku/plugins/ for runtime
        plugin-artifact-registry.ts  # auto-loads help manifests + skills.ts per plugin
        data-paths.ts         # cwd-relative path helpers (re-exported from mioku)
        plugin-runtime-state.ts
        logger.ts
        types.ts
      types.ts            # MiokuService, PluginHelp, CommandRole, …
      service-types.ts    # ConfigService, AIService, HelpService, ScreenshotService, …
  mioku-plugin-*/         # one folder per plugin
  mioku-service-*/        # one folder per service
example/                  # the dev/run playground (cwd when `bun run start` is invoked)
  app.ts                  # one-liner that calls start()
  package.json            # depends on every plugin/service via workspace:*
  config/mioku.json       # mioki/mioku runtime config (napcat ws, plugins list, …)
  plugins/, services/     # local plugin/service drops
docs/                     # VitePress site
```

## Dev commands

All commands run from the repo root unless noted.

| Command                                   | Purpose                                                                                                                       |
|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `bun run start`                           | Runs the example bot (`cd example && bun run start`).                                                                         |
| `bun run dev`                             | Watch-build the `mioku` package via tsdown (`cd packages/mioku && bun run dev`).                                              |
| `bun run build`                           | Builds every package that has a `tsdown.config.ts` or `src/`. Use to type-check the whole monorepo.                           |
| `bun run docs:dev` / `bun run docs:build` | VitePress docs site.                                                                                                          |
| `bunx tsc --noEmit` (root)                | Type-checks the whole monorepo (uses the root `tsconfig.json` which has `paths` for `mioku` → `packages/mioku/src/index.ts`). |
| `cd packages/<name> && bun run build`     | Build a single package.                                                                                                       |

Runtime dependencies the user (not the dev) needs: `bun`, `git`, a Chromium-family browser (for `mioku-service-screenshot`), `ffmpeg` for media plugins, and a NapCat / OneBot v11 endpoint reachable over WebSocket.

## How `start()` wires everything up

`mioku/src/index.ts:start()` is the single entry point and runs in this order:

1. `chdir(cwd)` — the example project is the cwd for everything that follows.
2. `mkdir data/ config/ temp/` if missing.
3. `pluginManager.discoverPlugins(miokuConfig)` — scans `plugins/` then `node_modules` for `mioku-plugin-*`. Also reads each plugin's `package.json` `mioku` field (declarative `services: string[]` and `help: PluginHelp`).
4. `prepareRuntimePluginLinks` — symlinks every discovered plugin into `.mioku/plugins/{name}` so mioki's loader can find them by name.
5. `serviceManager.discoverServices(miokuConfig)` — scans `services/` then `node_modules` for `mioku-service-*`.
6. Cross-checks `pluginManager.collectRequiredServices()` against the discovered services and warns about any gaps.
7. If `mioki.plugins` is **undefined** in the config, the auto-discovered plugin names are appended to `botConfig.plugins`. If it is explicitly set (even to `[]`), that whitelist is respected.
8. Hands off to `startMioki({ cwd })`. The `boot` plugin then runs first (it has `priority: -Infinity`) and is responsible for calling `serviceManager.loadAllServices(ctx)` and then `registerPluginArtifacts(ctx)`.

The implication for plugin authors: you only need `definePlugin({ name, async setup(ctx) { ... } })`. Pull services off `ctx.services`, register a Skill if you have one, and you're done. Don't try to manually invoke mioki loaders.

## Adding a plugin

Drop a folder in `example/plugins/<name>/` (local) or a published package named `mioku-plugin-<name>` (npm), and have it export default from `index.ts` (or `index.js`):

```ts
import { definePlugin, type MiokiContext } from "mioki";
import type { ConfigService } from "mioku";

export default definePlugin({
  name: "my-plugin",
  version: "1.0.0",
  description: "...",
  async setup(ctx: MiokiContext) {
    const config = ctx.services?.config as ConfigService | undefined;
    if (config) {
      await config.registerConfig("my-plugin", "base", { /* defaults */ });
    }
    ctx.handle("message", async (event) => { /* ... */ });
    return async () => { /* cleanup on shutdown */ };
  },
});
```

Conventions used across the existing plugins:

- `package.json` declares `"mioku": { "services": ["config", "ai"], "help": { ... } }` — services are auto-loaded by the boot plugin; help is auto-registered by `registerPluginArtifacts`.
- Plugin-local config defaults live in `configs/base.ts` (and friends). Always deep-clone before mutating and merge with the live config from `configService` so user overrides in `example/config/<plugin>/<name>.json` win.
- AI tools live in a separate `skills.ts` (default export or named `skills` export, single `AISkill` or array). This is loaded by `plugin-artifact-registry.ts` after services come up, **not** synchronously inside `setup`.
- Per-plugin runtime state goes through `getPluginRuntimeState` / `setPluginRuntimeState` from `mioku` (see `packages/mioku-plugin-help/runtime.ts` for the pattern).
- Storage paths must use the helpers from `mioku` (`getPluginDataDir`, `getPluginConfigDir`, `ensureDataDir`) — never hard-code `process.cwd() + ...`.

## Adding a service

A service is a single file with a default export satisfying `MiokuService` (`{ name, version, description?, init(), api, dispose?() }`):

```ts
import { logger } from "mioki";
import type { MiokuService } from "mioku";

const myService: MiokuService = {
  name: "my-service",
  version: "1.0.0",
  api: {} as any,
  async init() { this.api = new MyServiceImpl(); logger.info("my-service ready"); },
  async dispose() { /* cleanup */ },
};
export default myService;
```

Services are discovered by name (`mioku-service-<name>` → service name `<name>`), dynamically `import()`ed, and made available at `ctx.services[name].<api methods>`. The interfaces used today live in `packages/mioku/src/service-types.ts` (re-exported as types from the public `mioku` entry):

- `ConfigService` — `registerConfig / getConfig / updateConfig / onConfigChange`, file-backed in `config/{plugin}/{name}.json` with hot-reload via `fs.watch` + `lodash.debounce`.
- `HelpService` — `registerHelp / getHelp / getAllHelp / unregisterHelp`.
- `ScreenshotService` — Puppeteer-based HTML/Markdown/URL → PNG; temp cleanup.
- `AIService` — `create / get / list / setDefault` of `AIInstance` objects, plus a `registerSkill / getSkill` registry. Skills are namespaced (see below).
- `WebUIService` — HTTP admin UI on `:3339`.

## AI Skill system

Each plugin can register one `AISkill` (typically named the same as the plugin) containing many `AITool`s. Tools are called by the model as `{skill_name}.{tool_name}` — this avoids the namespace collision that global tool registration would cause. Both types are defined in `packages/mioku/src/service-types.ts` and `packages/mioku/src/core/types.ts`.

`AISkill` supports an optional `permission: "owner" | "admin" | "member"` field. The AI service uses this to gate tool invocation before the handler runs. Set the permission deliberately; defaulting to `member` is rarely what you want for side-effecting tools.

The chat plugin (`mioku-plugin-chat`) owns the `ChatRuntime` — the bridge that other plugins use to ask the running AI to generate a notice or collect structured information. See `mioku-service-ai/types.ts` for `ChatRuntime`, `ChatRuntimeNoticeOptions`, `ChatRuntimeInformationRequestOptions`, and `ChatRuntimeResult`. The `boot` plugin uses this to generate welcome messages on `notice.group.increase`.

## `example/` is the live test bench

`example/` is not a clean reference project — it's the author's running bot. Concretely:

- `example/app.ts` is the entrypoint used by `bun run start`.
- `example/package.json` is what `npx mioku` would scaffold for an end user; it depends on every package via `workspace:*`.
- `example/config/mioku.json` is the runtime config (mioki field holds napcat WS settings, owners, admins, the explicit `plugins` allowlist, plus plugin-specific sections like `boot`).
- `example/config/<plugin>/*.json` files override plugin defaults managed by `mioku-service-config` (e.g. `chat/settings.json`, `chat/personalization.json`).
- `example/plugins/demo` is a local-only throwaway plugin used to test discovery without polluting npm-published packages.

When you change a plugin or service, run it against `example/` to verify. The `data/`, `temp/`, `webui/`, and `.mioku/` directories under `example/` are runtime artifacts and are gitignored.

## CLI (`npx mioku`)

`packages/mioku/src/cli.ts` is the entrypoint for the `mioku` bin. Subcommands used during development:

- `npx mioku` — interactive scaffold: asks for project name, NapCat WS host/port/token, master QQ, whether to install WebUI.
- `npx mioku install plugin <name>` / `npx mioku install service <name>` — installs from the registry.
- `npx mioku update all` / `npx mioku update self` — version bumps.

The registry it pulls from is `official-registry.json` at the repo root (`{ plugins: { name: { npm | builtin } }, services: { ... } }`). When you publish a new package, add it here so the CLI can find it.

## Coding pitfalls (stuff the docs explicitly call out)

These are the rules future-you will trip over most often. Most of them are flagged in `docs/developer/plugin-advanced.md`, `docs/developer/plugin-ai.md`, and `docs/developer/plugin-start.md`.

- **Use `ctx.pickBot(e.self_id)`, not `ctx.bot`.** `ctx.bot` resolves to the *first* connected NapCat, not the one that fired the current event. With one bot it's a latent bug; with multiple bots it's broken — messages fail to send because the wrong bot is asked. Treat `ctx.bot` as if it didn't exist unless you specifically know you want the default bot. Source: `docs/developer/plugin-advanced.md` (the "不当使用 ctx.bot" warning).
- **Don't store runtime objects in module-level singletons.** mioki loads plugin code with `jiti` and `moduleCache` is off, so `const state = {}` at the top of `runtime.ts` is not stable across imports. Use `getPluginRuntimeState` / `setPluginRuntimeState` / `resetPluginRuntimeState` from `mioku` (they live in `packages/mioku/src/core/plugin-runtime-state.ts`). The pattern is in `packages/mioku-plugin-help/runtime.ts`. Source: `docs/developer/plugin-ai.md` "使用 runtime.ts 解决 index.ts 闭包".
- **Plugin data goes in `data/<pluginName>/`, not in `node_modules`.** Anything you write into `node_modules` is wiped on reinstall. Use the helpers from `mioku` — `getPluginDataDir`, `getServiceDataDir`, `getPluginConfigDir`, `getServiceConfigDir`, `ensureDataDir`. They are cwd-relative on purpose, so the bot works no matter where the project is checked out. Source: `docs/developer/plugin-advanced.md` "数据目录".
- **`skills.ts` runs outside `setup()`.** It's dynamically `import()`-ed by `plugin-artifact-registry.ts` after services come up, so closures over `setup()` locals are not available. Bridge shared state through `runtime.ts` (see pitfall above). Source: `docs/developer/plugin-ai.md` "编写 skills.ts".
- **Default export of `skills.ts` is `AISkill[]`** (or a single `AISkill`). The registry inspects `moduleExports.default`, then `moduleExports.skills`, then the module itself. Tools end up callable as `{skillName}.{toolName}` — namespace isolation is the whole point. Source: `packages/mioku/src/core/plugin-artifact-registry.ts` `extractSkills`.
- **All service types come from `"mioku"`, not from the individual `mioku-service-*` packages.** `AIService`, `ConfigService`, `HelpService`, `ScreenshotService`, `WebUIService` are re-exported by `packages/mioku/src/index.ts`. Do not import them from `mioku-service-ai/types` or similar — those are internal type duplicates.
- **Services may be missing.** Plugins that *declare* a service in `package.json` `mioku.services` are just *requesting* it; the user might not have installed it. Always `as ConfigService | undefined`, always `if (!service) { ctx.logger.warn(...); return; }`. Existing plugins follow this pattern; copy it.
- **Don't use `AISkill.permission` and `PluginHelp.command.role` interchangeably.** Skill permissions are `"owner" | "admin" | "member"` (defined in `packages/mioku/src/core/types.ts`). Help command roles are `"master" | "admin" | "owner" | "member"` — note the leading `master` for help, `owner` for skills. Mixing them up is a silent authz bug.
- **`ctx.handle("message", ...)` auto-dedupes across bots.** That's the right default. Pass `{ deduplicate: false }` (third arg) only when each bot really must act on the same event — e.g. the `boot` plugin's `赞我` handler does this so every connected bot likes the user. Source: `docs/developer/plugin-advanced.md` "多实例去重".
- **Keep `priority: -Infinity` on the `boot` plugin.** It has to load first so it can call `serviceManager.loadAllServices(ctx)` and then `registerPluginArtifacts(ctx)` before any other plugin's `setup()` runs. If you copy the boot plugin's shape, keep that priority.
- **`@` inside quoted/forwarded messages vs real mentions** — `ctx.text(event)` strips CQ/at segments. If you need to know whether the bot was actually @-mentioned, inspect `event.message` for `type === "at"` with `data.qq === String(event.self_id)`, not the raw text. Several plugins (`60s`, `chat`) do this distinction.
- **Plugin configs in `example/config/<plugin>/*.json` override `registerConfig()` defaults, not vice versa.** When you add a new field to a plugin's `BASE_CONFIG`, existing user JSON files won't have it — `lodash.merge` in `mioku-service-config` will fill in `undefined` for the missing key, so the default doesn't propagate after first registration. Read the live config back through `configService.getConfig()` and re-merge with your in-code default on every read (see how `mioku-plugin-boot` does `normalizeBootConfig`).

## Conventions worth knowing

- TypeScript everywhere, ESM, target ES2022, `bun` as runtime and package manager. Node engine pin is `>= 22.18.0`.
- The framework package builds with `tsdown` (`packages/mioku/tsdown.config.ts`); other packages don't have a build step at all in the root script — they're consumed as raw `.ts` via bun.
- A handful of services ship a prebuilt `dist/` (e.g. `mioku-service-ai`, `mioku-service-webui`); the rest are loaded as `.ts` at runtime.
- The `skills-lock.json` at the repo root pins a remote Claude skill (`mioku-developer`); don't edit it manually.
- The `.agents/` and `.claude/` directories are local to the developer — they're gitignored.
- `mioku-service-config` has a typo in the type filename: `tpyes.ts` (not `types.ts`). Don't "fix" it without updating all the imports.

## Coding style

This is the house style the rest of the codebase follows. Match it; don't invent your own.

### Split logic across files; keep `index.ts` thin

`index.ts` of a plugin is the wiring file — `definePlugin({...})` and a `setup(ctx)` that registers handlers. It should not contain the actual implementation. Look at how the existing plugins are organized for the canonical shape:

- `mioku-plugin-chat/` — `index.ts` (wiring) + `core/` (chat engine, prompts, multimodal, tools, media) + `manage/` (sessions, rate limiter, cooldown, queue, idle) + `utils/` + `humanize/` + `db.ts` + `types.ts` + `configs/`.
- `mioku-plugin-help/` — `index.ts` + `help/` (intent, info, html, image, role config) + `status/` (intent, samplers, html, image) + `runtime.ts` + `skills.ts` + `theme.ts` + `utils.ts` + `demo-config.ts`.
- `mioku-plugin-admin/` — `index.ts` + `commands/` + `notify/` + `skills/` + `skills.ts` + `config.ts`.

The naming is conventional: a folder per concern, kebab-case for files. When adding a new plugin, sketch out the folder layout in your head **before** writing `index.ts`. If `setup()` is going to exceed ~150 lines, you are almost certainly missing a sub-module.

A few specifics that fall out of this:

- Plugin default configs go in `configs/<name>.ts` (e.g. `configs/base.ts`, `configs/settings.ts`, `configs/personalization.ts`). `BASE_CONFIG` is a const, deep-cloned at the top of `setup()` so plugin code never mutates the in-code default.
- AI tool handlers go in `skills.ts` and stay small — each handler should be a thin wrapper that pulls runtime state from `runtime.ts` and returns a JSON-shaped result. If a handler is more than ~30 lines, the heavy lifting belongs in a sibling module.
- DB / lowdb wiring lives in `db.ts` (or `core/db.ts`); the rest of the plugin talks to a small `db` object, not `lowdb` directly.
- One shared `types.ts` per plugin, exporting only what other files in that plugin import — don't duplicate types from `mioku`/`mioki`.

### Comments: don't add them

**Default to no comments.** Well-named code is self-explanatory. Do not restate what the code says.

- Simple/obvious logic: no comment.
- Complex or non-obvious code: a short one-liner is fine, but only if it captures the *why* (a workaround, a subtle invariant, a hidden constraint) — never the *what*.
- JSDoc / multi-line comment blocks: not the local style. Don't.
- No "added for #123", "called by X", or "TODO: refactor" — those belong in commit messages / issue tracker, not source.
- Type definitions don't need docstrings. If the name doesn't carry the meaning, rename it; don't paper over it with prose.

### Logging: log the boundaries, not the body

Use `ctx.logger` (and the framework `logger` from `mioki` for code paths that don't have a `ctx`). The shape that holds up:

- **Service / plugin `init()` and `dispose()`** — one `logger.info("xxx-service 已就绪")` / `"xxx 已卸载"`. This is what shows up in the boot banner; the user wants to see each service come online.
- **Plugin `setup()` start / finish** — bracket the whole thing with two info lines (e.g. `boot` does `Mioku 正在引导服务...` and `Mioku 服务初始化完成`). It makes the boot log skimmable.
- **Handler entry** — do *not* log on every message. The deduper / message counter is for that. Log at the handler level only when the handler is doing something rare or non-obvious (e.g. "auto-approving friend request from $userId").
- **Failure paths** — `ctx.logger.error(...)` with the error object/stringified. Always include the operation that failed and the relevant ids. Don't `throw` then silently `return`; either let it bubble or log and continue, but pick one.
- **Branching warnings** — when a service is missing or a config field is malformed, `ctx.logger.warn(...)` and continue with a sensible default. The current plugins all do this; copy the phrasing.
- **No `console.log`.** Use `ctx.logger`. (The `cli.ts` scaffolder uses `consola` because it runs before any plugin is loaded — that's the only legitimate exception.)

Concretely, the right places to log are: `init`/`dispose`, `setup` start/finish, every `catch` block, and any branch where the plugin silently degrades. Inside a normal message handler that just routes and replies, no log is needed.

### Tell the user when something goes wrong

A plugin that swallows errors and only writes to `ctx.logger.error` is invisible to the user in QQ. Whenever a command fails in a way the user can act on, **also** send a message back, ideally via `chat-runtime` so it picks up the bot's persona:

```ts
const ai = ctx.services?.ai as AIService | undefined;
const chatRuntime = ai?.getChatRuntime();

try {
  await doTheThing();
} catch (err) {
  ctx.logger.error(`my-plugin doTheThing 失败: ${err}`);
  if (chatRuntime) {
    await chatRuntime.generateNotice({
      event,
      instruction: `告诉用户：xxx 失败了，原因是 ${String(err)}`,
      send: true,
    });
  } else {
    // chat 插件没启用时的兜底：直接发纯文本
    await event.reply(`xxx 失败了：${String(err)}`);
  }
}
```

- `chatRuntime.generateNotice` reuses the chat plugin's persona and recent context, so the message sounds like the bot, not like a stack trace. Prefer it over a flat `event.reply`.
- The instruction is the *directive to the model*, not the user-facing text. Phrase it as "告诉用户：…" so the model knows it should output natural language, not just echo the string.
- `send: true` actually posts the message. Pass `send: false` if you want the generated `messages` array in the result so you can edit or compose before sending — useful for batched replies.
- Always guard with `if (chatRuntime)` — the chat plugin may not be installed, and `getChatRuntime()` returns `undefined` in that case. Fall back to a direct `event.reply`.
- For non-fatal but worth-mentioning conditions (rate limit, blacklist hit, missing permission), still go through `chatRuntime.generateNotice` so the reply stays in-voice. The `boot` plugin's welcome-message code is the cleanest reference (`packages/mioku-plugin-boot/index.ts` `buildWelcomeMessage`).
- Don't use `chatRuntime` for tool handlers in `skills.ts` — those run in response to model decisions, and the model already knows what happened. For tool errors, return `{ error: "..." }` and let the chat plugin render it.
