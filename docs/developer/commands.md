---
title: 命令管理器
description: 用 ctx.command 注册消息命令，包含字段、匹配、优先级与权限。
---

# 命令管理器

Mioku 的命令管理器负责命令的注册、匹配、前缀、优先级、角色权限、访问控制和帮助目录。插件通过 `ctx.command()` 注册消息命令，通过 `ctx.handle()` 监听戳一戳、入群申请和媒体消息等不属于命令的事件。

命令管理器在事件总线之前工作。命中的命令会消费消息，剩余事件才交给 `handle`。handler 可以通过返回值把消息让给后面的处理者，见[让位与认领](#让位与认领)。

## 最小命令

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "weather",
  setup(ctx) {
    ctx.command({
      name: "weather",
      description: "查询城市天气",
      handler({ event, args }) {
        const city = args.join(" ") || "当前城市";
        return event.reply(`查询 ${city}`);
      },
    });
  },
});
```

上面的注册会响应 `.weather 上海`。`handler` 收到的 `args` 是按空白切分的参数数组。正则命令还会附带 `match` 捕获组。

## 字段

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识，默认等于 `name`，`access-control.json` 与 WebUI 用它定位命令 |
| `name` | 命令主名，命令目录中展示的主要名字 |
| `aliases` | 同义名数组，例如 `["天气", "tq"]` 让 `.天气` 和 `.tq` 触发同一条命令 |
| `match` | 正则或字符串匹配器，省略时按 `name` 精确匹配 |
| `prefixes` | 前缀列表，默认取 `mioku.prefix`，传 `false` 表示不要求前缀 |
| `permission` | 命令角色，可选 `member`、`admin`、`owner` 或 `master`，默认 `member` |
| `priority` | 升序优先级，数值越小越先匹配，默认 0 |
| `description` | 帮助与 WebUI 中展示的说明 |
| `usage` | 用法示例，例如 `"weather <城市>"` |
| `handler` | 命令处理函数，返回 `false` 表示把消息让给后续处理者 |

`aliases` 只对字符串匹配生效，不会出现在帮助和 WebUI 中，也不参与 `id` 计算。

## handler 入参

```typescript
ctx.command({
  name: "translate",
  match: /^翻译\s+(.+)$/,
  async handler({ ctx, event, command, text, body, args, match }) {
    // ctx       插件上下文
    // event     消息事件
    // command   当前注册的命令对象，只读
    // text      消息的原始纯文本
    // body      去掉前缀后的文本
    // args      字符串参数数组
    // match     正则匹配结果，仅当 match 为正则时存在
    await event.reply(`待翻译：${match?.[1] ?? args.join(" ")}`);
  },
});
```

## 正则与多前缀

需要更细的匹配时，把 `match` 换成正则。

```typescript
ctx.command({
  name: "translate",
  match: /^翻译\s+(.+)$/,
  prefixes: [".", "/", "#"],
  description: "翻译文本",
});
```

`prefixes` 可以是单个前缀、字符串数组，或 `false`。空字符串前缀 `""` 表示同时支持裸命令与带前缀命令。例如 `["#", "/", ""]` 可以命中 `#help`、`/help` 和 `help`。

### prefixes 设为 false

`prefixes: false` 表示不强制要求前缀。命令管理器会同时尝试裸命令和带默认前缀两种写法，`.weather` 和 `weather` 都能命中。

```typescript
ctx.command({
  name: "weather",
  prefixes: false,
});
```

如果想限定具体允许哪些前缀，包括裸命令，使用数组写法。

```typescript
ctx.command({
  name: "weather",
  prefixes: ["", ".", "/"],   // weather、.weather、/weather 都命中
});
```

需要注意两点。

- `[""]` 与 `false` 在匹配上等价，但帮助中的展示不同。`false` 展示为 `weather`，表示这是裸命令；`[""]` 展示为 `.weather`。
- 命令管理器按前缀长度倒序尝试剥除，长前缀优先。例如 `"/"` 优先于 `""`。

## aliases

`aliases` 是字符串同义名数组，用于让同一个 handler 响应多个名字。

```typescript
ctx.command({
  name: "weather",
  aliases: ["天气", "tq", "查天气"],
  description: "查询城市天气",
  handler: ({ event, args }) => event.reply(`查询 ${args.join(" ")}`),
});
```

`.weather`、`.天气`、`.tq` 和 `.查天气` 都会路由到同一个 handler。

`aliases` 与 `name` 的差异如下。

- **触发**：都生效，匹配顺序是 `match`、`name`、`aliases[0]`、`aliases[1]`，依次类推。
- **展示**：帮助和 WebUI 列表只展示 `name`。
- **id**：始终等于 `name`，除非显式设置 `id`。别名不会成为独立的命令 id，因此 `access-control.json` 仍按 `name` 配置。
- **正则命令**：不需要别名，在正则中使用 `|` 分支即可，例如 `match: /^天气|weather/`。

命令改名时，把旧名放进 `aliases` 就能兼容老用户。

## 简写

只需要名字和处理器时，可以直接传入字符串或正则。

```typescript
ctx.command("ping", ({ event }) => event.reply("pong"), {
  description: "连通性测试",
});

ctx.command(/^echo\s+(.+)$/, ({ event, match }) => event.reply(match![1]), {
  name: "echo",
  prefixes: ["."],
});
```

## 优先级与冲突

命令按 `priority` 升序尝试，数值越小越先尝试，同优先级按注册顺序。把通用命令放在较低优先级、专用命令放在较高优先级，就能控制尝试顺序。

```typescript
ctx.command({
  name: "roll-d20",
  match: /^roll(?:\s+d(\d+))?$/i,
  priority: 10,
  description: "投骰子",
});

ctx.command({
  name: "roll-d6",
  match: /^roll\s+d6$/i,
  priority: 1, // 比 roll-d20 小，先尝试
  description: "投六面骰",
});
```

## 让位与认领

handler 的返回值决定这条消息是否归它。

| 返回值                    | 含义                                        |
|------------------------|-------------------------------------------|
| `true`                 | 认领。派发到此结束，后续命令和 `handle` 都不会收到            |
| `undefined`（不写 return） | 认领，与 `true` 等价，保持既有行为                     |
| `false`                | 让位。继续尝试后续命令；全部让位则消息流向事件总线，交给 `ctx.handle` |

典型场景是同名文本在不同语境下含义不同。

```typescript
ctx.command({
  name: "退群",
  match: /^退群(?![\u4e00-\u9fa5A-Za-z0-9_])/,
  prefixes: ["", ".", "/"],
  permission: "master",
  handler: async ({ event, body }) => {
    // 引用通知的回复交给通知处理器，不在这里消费
    if (event.quote_id && event.message_type === "private") return false;
    // ...正常执行退群
  },
});
```

## 权限

`permission` 字段决定谁能触发命令。

| 值 | 谁能触发 |
| --- | --- |
| `member` | 所有人，默认值 |
| `admin` | bot 主人、配置管理员、当前群群主或群管理员 |
| `owner` | bot 主人或当前群群主 |
| `master` | 仅 bot 主人 |

权限由命令管理器在派发时执行，插件不需要在 handler 中再判断一次。需要处理 CD 豁免或二次确认这类非命令分支时，才使用 `ctx.isMaster(event)`、`ctx.isOwner(event)` 和 `ctx.isAdmin(event)`。

角色的完整说明和名单配置见[权限与访问控制](/developer/permissions)。

## 访问控制

访问控制文件位于 `config/core/access-control.json`，可以按群、按用户覆盖角色规则。文件结构、优先级和示例见[权限与访问控制](/developer/permissions)。

## 卸载

`ctx.command()` 返回注销函数，上下文会在插件卸载时自动调用。在 `setup` 之外手动管理注册时，需要在清理函数中调用它。

## 旧清单字段

`mioku.accessHooks` 与 `mioku.help` 是旧版 manifest 的兼容字段。新插件应把命令注册写在 `setup` 中，通过 `ctx.command()` 声明，不要再自行实现前缀匹配和主人判断。

## 下一步

- [事件处理](/developer/events)：用 `ctx.handle()` 监听非命令事件
- [权限与访问控制](/developer/permissions)：角色与访问规则
- [插件间通信](/developer/communicate)：在插件之间共享能力
