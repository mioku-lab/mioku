---
title: 开发适配器
description: 使用 defineAdapter 编写 Mioku 适配器，包含事件构造、类型注册与能力注册。
---

# 开发适配器

适配器是框架与平台之间的连接层。它把平台的原始消息转换成框架的统一事件，也把插件调用的能力翻译成平台指令。

适配器是一个 `mioku-adapter-*` npm 包，核心是一个 `defineAdapter` 对象。下面照 `mioku-adapter-stdin` 的结构，从零编写一个可以运行的适配器。

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

各字段说明如下。

| 字段 | 说明 |
| --- | --- |
| `name` | 适配器名，必须等于包短名，例如 `mioku-adapter-my` 对应 `my` |
| `version` | 适配器版本 |
| `apiVersion` | 框架与适配器的协议版本，当前必须是 `1`，不匹配时直接拒绝加载 |
| `validateConfig` | 可选，把 `mioku.adapters.my` 中的原始配置校验并归一化为配置类型 |
| `create` | 返回适配器实例，实例需要实现 `start` 和 `stop` |

`create` 返回的适配器实例结构如下。

```typescript
interface Adapter {
  name: string;
  version: string;
  start(context: AdapterContext): void | Promise<void>;
  stop(reason?: string): void | Promise<void>;
}
```

`start` 中建立连接、注册 bot 和能力。`stop` 中断开连接、释放资源。框架启动时逐个调用 `create` 和 `start`，关闭时逐个调用 `stop`。

## 示例：echo 适配器

下面编写一个极简适配器。它从标准输入读取一行并作为消息派发，收到消息后原样回显。它不接入任何真实平台，但完整展示了适配器的生命周期。

```typescript
import * as readline from "node:readline";
import {
  bindCapabilities,
  messageSend,
  type Adapter,
  type AdapterContext,
} from "mioku";

const BOT_ID = "echo";

const build = (): Adapter => {
  let stopHook: (() => void) | undefined;

  return {
    name: "echo",
    version: "1.0.0",

    async start(context: AdapterContext) {
      // 创建 bot 并注册
      const bot = bindCapabilities(createEchoBot(), context.getCapabilityRegistry());
      const botRef = context.registerBot(bot);

      // 注册能力，message.send 由这个适配器实现
      const unregisterSend = context.registerCapability(
        messageSend,
        { adapter: "echo", bot_id: BOT_ID },
        async (req) => bot.sendMessage(req.target, req.message),
      );

      // 接收输入流，构造事件并派发
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        await context.dispatch(buildMessageEvent(bot, line));
      });

      // 广播 bot 上线
      await context.emitLifecycle({ type: "bot:connected", bot });

      // stop 时统一反注册
      stopHook = () => {
        rl.close();
        unregisterSend();
        botRef.unregister();
      };
    },

    async stop() {
      stopHook?.();
    },
  };
};

export const echoAdapter = defineAdapter({
  name: "echo",
  version: "1.0.0",
  apiVersion: 1,
  create: () => build(),
});
```

框架在这个例子中承担了大部分工作。`bindCapabilities` 把能力绑定成 bot 的方法，`registerBot` 让插件可以通过 `ctx.bots` 和 `ctx.pickBot` 拿到它，`dispatch` 把事件送进总线，`emitLifecycle` 触发 `bot:connected`。

## bot 与类型注册

bot 不需要实现 `BotBase` 的全部方法，`bindCapabilities` 会按能力注册表自动补上。适配器只需要实现自己的部分，例如 `bot_id`、`sendMessage` 和 `sendApi`，再用 `AdapterBotBase` 声明。

```typescript
import type {
  AdapterBotBase,
  BotBase,
  MessageInput,
  MessageTarget,
  SentMessage,
} from "mioku";

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

`declare module "mioku"` 中的 `AdapterBotMap` 是类型层面的注册。写好之后插件侧立刻受益。

- `ctx.handle("echo:message", ...)` 中的 `event.bot` 自动推断为 `EchoBot`，原理见[路由与类型推断](/developer/events#路由与类型推断)。
- `ctx.bots` 的联合类型中会多出 `EchoBot`，`if (bot.adapter === "echo")` 可以自动收窄。
- `ctx.pickBot<EchoBot>("...")` 和 `bot.as<EchoBot>()` 有了具体类型可用。

类型注册完成之后，插件开发全程都有提示。

## 构造事件

`buildMessageEvent` 是适配器最核心的样板代码，负责把平台消息翻译成框架事件。

```typescript
import {
  buildRoutes,
  createMessage,
  segment,
  type EventIdentity,
  type MessageEvent,
} from "mioku";

function buildMessageEvent(bot: EchoBot, line: string): MessageEvent {
  const id = `echo:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const identity: EventIdentity = {
    adapter: "echo",
    bot_id: BOT_ID,
    event_type: "message.private",
    message_id: id,
    timestamp: Date.now(),
  };
  return {
    kind: "message",
    type: "message",
    routes: buildRoutes("echo", "message", "private"),
    identity,
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
    reply: (input, _options) =>
      bot.sendMessage({ type: "private", user_id: "echo-user" }, input),
    recall: async () => {},
  };
}
```

以下部分是必须的。

- **`kind`**：事件大类，消息事件固定为 `"message"`。框架依靠它分发到对应的类型守卫。
- **`routes`**：通过 `buildRoutes(adapter, ...parts)` 生成。它会从细到粗构造一整套路由，例如 `echo:message.private`、`echo:message`、`echo`、`message.private` 和 `message`。插件监听任意一层都能收到事件。
- **`identity`**：事件级标识，包含适配器、bot、事件类型、平台消息 id 和时间戳。跨适配器关联去重会从这里读取 `event_type`、`timestamp` 和 `message_id`。
- **`at` 段**：把平台的 at 归一化成 `at` 段，data 中使用 `qq` 或 `target` 字段。`ctx.mentionedBots` 依赖它判断 at 到了哪台 bot。
- **`bot` 与 `self_id`**：指向触发事件的 bot。
- **`reply` 与 `recall`**：便捷方法，内部转发到 bot 的能力。

notice 和 request 事件的结构类似，`kind` 分别换成 `"notice"` 和 `"request"`，字段见[事件类型](/developer/events)。完整结构见 [EventBase](/reference/api/interfaces/EventBase)。

## 注册能力

能力是适配器对框架的承诺。注册一项能力就是告诉框架，这个目标上的这件事由本适配器实现。上面的例子中只注册了 `message.send`。

```typescript
import { messageSend } from "mioku";

context.registerCapability(
  messageSend,                          // 能力定义，从 mioku 导入
  { adapter: "echo", bot_id: BOT_ID },  // 作用目标
  async (req) => bot.sendMessage(req.target, req.message),  // 实现
);
```

`messageSend` 这类能力定义都在 `mioku` 顶层导出，适配器直接使用。想实现更多能力，例如禁言、查询群和撤回，从 `mioku` 导入对应的能力定义逐个注册即可。完整清单和自定义能力的写法见[能力系统](/developer/capability-dev)。

## 上报状态

用户发送 `.adapter` 时，core 会逐个 bot 向适配器请求一次状态，用于渲染实例列表。`.status` 中的收发总数也是从这些上报汇总出来的。适配器通过 `registerStatusProvider` 登记回调。

```typescript
import { registerStatusProvider } from "mioku";

const unregister = registerStatusProvider(
  { adapter: "echo", bot_id: BOT_ID },
  async ({ bot }) => ({
    adapter: "echo",
    bot_id: bot.bot_id,
    impl: "echo-server",               // 平台自报的实现名，可省略
    version: "1.2.3",                  // 实现端版本，可省略
    protocol: "v11",                   // 协议版本，例如 OneBot 的 v11，可省略
    platform: "aPad",                  // 登录设备，可省略
    platform_version: "9.3.50.40225",  // 登录设备的客户端版本，可省略
    stats: {
      friends: 128,
      groups: 32,
      sent: 3312,
      received: 51234,
    },
    data: { anything: "只给插件读取，core 不展示" },
  }),
);
```

`stats` 中的字段含义如下。

| 字段 | 含义 |
| --- | --- |
| `friends` | 好友或私聊联系人数 |
| `groups` | 群或频道数 |
| `sent` | 已发送消息数 |
| `received` | 已接收消息数 |

## 配置

用户侧的配置写在 `mioku.adapters.my` 下。

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

`validateConfig` 负责把它校验成适配器真正使用的配置类型。

```typescript
interface EchoConfig {
  prefix?: string;
}

function normalizeConfig(input: unknown): EchoConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  return { prefix: typeof raw.prefix === "string" ? raw.prefix : undefined };
}
```

框架会先调用 `validateConfig`，再把结果通过 `create` 的 `options.config` 传入。

## 打包与发布

适配器包的 `package.json` 要点如下。

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

- `name` 必须是 `mioku-adapter-*`，框架按前缀发现，短名即适配器名。
- 必须安装在使用方的 `dependencies` 中，不能只放在 `devDependencies`，否则无法被发现。
- 入口使用 `index.ts` 即可，由 jiti 加载，`main` 指向它。
- 发布前先在本地项目中用 `bun add mioku-adapter-echo` 安装一次验证。

安装后用户在 `mioku.adapters` 中配置并启用。可选的配置向导写在 `cli.ts` 中，用户通过 `bunx mioku-adapter-echo` 交互式生成配置。向导的写法与普通 CLI 相同，框架没有额外要求。

## 下一步

- [能力系统](/developer/capability-dev)：能力的定义与自定义
- [适配器](/guide/adapters)：用户侧的安装与配置
- [AdapterContext 类型参考](/reference/api/interfaces/AdapterContext)：适配器上下文的完整接口
