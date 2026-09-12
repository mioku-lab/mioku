# 开发适配器

适配器是框架与平台之间的连接层：把平台的原始消息变成框架的统一事件，把插件调用的能力翻译成平台指令。

适配器是一个 `mioku-adapter-*` npm 包，核心是一个 `defineAdapter` 对象。我们照着 `mioku-adapter-stdin` 的样子，从零写一个能跑的适配器。

## 适配器定义

```typescript
import { defineAdapter } from "mioku";
import type { AdapterDefinition, AdapterFactoryOptions } from "mioku";

export const myAdapter = defineAdapter<MyConfig>({
  name: "my",
  version: "1.0.0",
  apiVersion: 1,
  validateConfig: (input) => normalizeConfig(input),
  create: (options: AdapterFactoryOptions<MyConfig>) => build(options.config, options.logger),
});
```

各字段：

| 字段               | 说明                                           |
|------------------|----------------------------------------------|
| `name`           | 适配器名，**必须等于包短名**（`mioku-adapter-my` → `my`）  |
| `version`        | 适配器版本                                        |
| `apiVersion`     | 框架与适配器的协议版本，当前必须是 `1`，不匹配直接拒绝加载              |
| `validateConfig` | 可选，把 `mioku.adapters.my` 里的原始配置校验/归一化成你的配置类型 |
| `create`         | 返回适配器实例（`start` / `stop` 两个方法）               |

`create` 返回的适配器实例：

```typescript
interface Adapter {
  name: string;
  version: string;
  start(context: AdapterContext): void | Promise<void>;
  stop(reason?: string): void | Promise<void>;
}
```

`start` 里做连接、注册 bot 和能力；`stop` 里断开连接、释放资源。框架启动时逐个 `create` + `start`，关闭时逐个 `stop`。

## 示例适配器：echo

写一个极简适配器：从标准输入读一行，当成消息派发；收到消息后原样回显。它不接任何真实平台，但能完整展示适配器的生命周期。

```typescript
import * as readline from "node:readline";
import {
  bindCapabilities,
  buildRoutes,
  createMessage,
  defineAdapter,
  segment,
  type AdapterContext,
  type MessageEvent,
} from "mioku";

const BOT_ID = "echo";

export const echoAdapter = defineAdapter({
  name: "echo",
  version: "1.0.0",
  apiVersion: 1,
  create: () => ({
    name: "echo",
    version: "1.0.0",
    async start(context: AdapterContext) {
      // 造一个 bot 并注册
      const bot = bindCapabilities(createEchoBot(), context.getCapabilityRegistry());
      const botCtx = context.registerBot(bot);

      // 注册能力：message.send 由这个适配器实现
      const unregister = context.registerCapability(
        messageSend,
        { adapter: "echo", bot_id: BOT_ID },
        async (req) => bot.sendMessage(req.target, req.message),
      );

      // 接输入流，构造事件派发
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const event = buildMessageEvent(bot, line);
        await context.dispatch(event);
      });

      // 广播 bot 上线
      await context.emitLifecycle({ type: "bot:connected", bot });

      // stop 时全部反注册
      contextStop = () => {
        rl.close();
        unregister();
        botCtx.unregister();
      };
    },
    async stop() {
      contextStop?.();
    },
  }),
});
```

这个例子里框架替我们做了几乎所有事情：`bindCapabilities` 把能力绑成 bot 方法，`registerBot` 让插件能从 `ctx.bots` / `ctx.pickBot` 拿到它，`dispatch` 把事件送进总线，`emitLifecycle` 触发 `bot:connected`。

## 事件怎么构造

`buildMessageEvent` 是适配器最核心的样板代码——把平台消息翻译成框架事件：

```typescript
import { buildRoutes, createMessage, segment, type MessageEvent } from "mioku";

function buildMessageEvent(bot: EchoBot, line: string): MessageEvent {
  const id = `echo:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  return {
    kind: "message",
    type: "message",
    routes: buildRoutes("echo", "message", "private"),
    identity: {
      adapter: "echo",
      bot_id: BOT_ID,
      event_type: "message.private",
      message_id: id,
      timestamp: Date.now(),
    },
    self_id: BOT_ID,
    bot,
    time: Date.now(),
    raw: { line },
    message_type: "private",
    user_id: "echo-user",
    message_id: id,
    raw_message: line,
    sender: { user_id: "echo-user", nickname: "echo", role: "owner" },
    message: createMessage([segment.text(line)], line),
    is_to_me: true,
    reply: (input, _options) => bot.sendMessage({ type: "private", user_id: "echo-user" }, input),
    recall: async () => {},
  };
}
```

几个必须有的部分：

- **`kind`**：事件大类，消息事件就是 `"message"`。框架靠它分发到对应的类型守卫
- **`routes`**：用 `buildRoutes(adapter, ...parts)` 生成——它会从细到粗构造一整套路由（`echo:message.private`、`echo:message`、`echo`、`message.private`、`message`），插件监听任意一层都能收到
- **`identity`**：事件级标识（适配器、bot、事件类型、平台消息 id、时间戳）。核心的跨适配器关联去重从这里取 `event_type` / `timestamp` / `message_id`
- **`at` 段**：把平台的 @ 归一化成 `at` 段（`data.qq` 或 `data.target`）。核心的 `ctx.mentionedBots` 依赖它来判断「@ 到了哪台 bot」
- **`bot` / `self_id`**：指向触发事件的 bot
- **`reply` / `recall`**：便捷方法，内部转发到 bot 的能力

notice、request 事件结构类似，`kind` 分别换成 `"notice"` / `"request"`，字段看[事件类型](/developer/events)。完整的事件结构见[类型参考](/reference/api/interfaces/EventBase)。

## bot 与类型注册

bot 不需要实现 `BotBase` 的全部方法——`bindCapabilities` 会按能力注册表自动补上。适配器只要实现自己的部分（`bot_id`、`sendMessage`、`sendApi` 等），再用 `AdapterBotBase` 声明：

```typescript
import type { AdapterBotBase, BotBase } from "mioku";

export interface EchoBot extends BotBase {
  readonly adapter: "echo";
  sendMessage(target: MessageTarget, message: MessageInput): Promise<SentMessage>;
}

export type EchoBotBase = AdapterBotBase<EchoBot>;

// 让框架知道 echo 适配器的 bot 类型，ctx.bot 的类型就能推导出来
declare module "mioku" {
  interface AdapterBotMap {
    echo: EchoBot;
  }
}

export function createEchoBot(): EchoBotBase {
  return {
    adapter: "echo",
    get bot_id() { return BOT_ID; },
    get online() { return true; },
    async sendMessage(_target, message) {
      console.log(`[echo] ${String(message)}`);
      return { message_id: `echo:${Date.now()}` };
    },
    async sendApi() { throw new Error("echo 不支持任意平台 API"); },
  };
}
```

`declare module "mioku"` 的 `AdapterBotMap` 是类型层面的注册，写完后插件侧立刻受益：

- `ctx.handle("echo:message", ...)` 里 `event.bot` 自动推断为 `EchoBot`（路由推断，见[事件处理](/developer/events#路由与类型推断)）
- `ctx.bots` 的联合类型里多出 `EchoBot`，`if (bot.adapter === "echo")` 能自动收窄
- `ctx.pickBot<EchoBot>("...")` / `bot.as<EchoBot>()` 有了具体类型可用

这是适配器包给插件开发者的最大福利——类型注册好了，插件写起来全程有提示。

## 注册能力

能力是适配器对框架的承诺。注册一项能力就是告诉框架：这个目标上，「这件事」由我实现。上面例子里只注册了 `message.send`：

```typescript
import { messageSend } from "mioku";

context.registerCapability(
  messageSend,                          // 能力定义（从 mioku 导入）
  { adapter: "echo", bot_id: BOT_ID },  // 作用目标
  async (req) => bot.sendMessage(req.target, req.message),  // 实现
);
```

`messageSend` 这类能力定义都在 `mioku` 顶层导出，适配器直接拿来用。想实现更多（禁言、查群、撤回），就从 `mioku` 导入对应的能力定义逐个注册。完整清单和自定义能力见[能力系统](/developer/capability-dev)。

## 上报状态

用户发 `.adapter` 时，core 会逐个 bot 向适配器要一次状态，用来渲染实例列表；`.status` 里的收发总数也是从这些上报汇总出来的。适配器用 `registerStatusProvider` 登记回调：

```typescript
import { registerStatusProvider } from "mioku";

const unregister = registerStatusProvider(
  { adapter: "echo", bot_id: BOT_ID },
  async ({ bot }) => ({
    adapter: "echo",
    bot_id: bot.bot_id,
    impl: "echo-server",       // 平台自报的实现名，可省
    version: "1.2.3",          // 实现端版本，可省
    protocol: "v11",           // 协议版本，如 OneBot 的 v11，可省
    platform: "aPad",          // 登录设备，可省
    platform_version: "9.3.50.40225", // 登录设备的客户端版本，可省
    stats: {
      friends: 128,
      groups: 32,
      sent: 3312,
      received: 51234,
    },
    data: { anything: "只给插件读，core 不展示" },
  }),
);
```

| 字段         | 含义             |
|------------|----------------|
| `friends`  | 好友 / 私聊联系人数    |
| `groups`   | 群 / 频道数        |
| `sent`     | 已发送消息数         |
| `received` | 已接收消息数         |

## 配置

用户侧的配置长这样（`mioku.adapters.my`）：

```json
{
  "mioku": {
    "adapters": {
      "echo": {
        "prefix": "echo> "
      }
    }
  }
}
```

`validateConfig` 负责把它校验成适配器真正用的配置类型：

```typescript
interface EchoConfig {
  prefix?: string;
}

function normalizeConfig(input: unknown): EchoConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  return { prefix: typeof raw.prefix === "string" ? raw.prefix : undefined };
}
```

框架会先调 `validateConfig`，再把它传给 `create` 的 `options.config`。

## 打包与发布

适配器包的 `package.json` 要点：

```json
{
  "name": "mioku-adapter-echo",
  "version": "1.0.0",
  "main": "index.ts",
  "type": "module",
  "keywords": ["mioku"],
  "peerDependencies": {
    "mioku": "^1.0.0"
  }
}
```

- `name` 必须是 `mioku-adapter-*`，框架按前缀发现，短名即适配器名
- **必须装进使用方的 `dependencies`**（不是 `devDependencies`），否则发现不到
- 入口用 `index.ts` 即可（jiti 加载），`main` 指到它
- 发布前在本地项目里 `bun add mioku-adapter-echo` 装一遍验证

装好后用户在 `mioku.adapters` 里配置并启用。可选的配置向导（`cli.ts`）能让用户通过 `bunx mioku-adapter-echo` 交互式生成配置，做法和普通 CLI 一样，没有框架特殊要求。

## 参考

- [能力系统](/developer/capability-dev) —— 能力怎么定义、怎么自定义
- [适配器使用指南](/guide/adapters) —— 用户侧的安装与配置
- [AdapterDefinition 类型参考](/reference/api/interfaces/AdapterDefinition)
- [AdapterContext 类型参考](/reference/api/interfaces/AdapterContext)
- [AdapterStatus 类型参考](/reference/api/interfaces/AdapterStatus)