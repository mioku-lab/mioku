# 命令管理器

Mioku 的命令管理器负责命令注册、匹配、前缀、优先级、角色权限、访问控制和帮助目录。插件通过 `ctx.command()` 注册消息命令，`ctx.handle()` 继续用于戳一戳、入群申请、媒体消息等不属于命令的事件。

命令管理器在事件总线之前工作。命中的命令会消费消息，剩余事件再交给 `handle`。所以同一触发文本不要同时注册命令和 `handle`，否则会被其中一个抢先处理。

## 最小命令

```ts
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

上面的注册会响应 `.weather 上海`。`handler` 收到的 `args` 是按空白切分的参数数组，正则命令还会附带 `match` 捕获组。

## 字段

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识，默认等于 `name`；`access-control.json` 与 WebUI 用它定位命令 |
| `name` | 命令主名，命令目录展示的主要名字 |
| `aliases` | 同义名数组，例如 `["天气", "tq"]` 会让 `.天气`、`.tq` 都触发同一条命令。仅对字符串匹配生效；不在帮助/WebUI 中展示，也不参与 `id` 计算 |
| `match` | 可选，正则或字符串匹配器；省略时按 `name` 精确匹配 |
| `prefixes` | 前缀列表，默认 `["."]`（取自 `mioku.prefix`），传 `false` 表示不要前缀 |
| `permission` | 命令角色：`member` / `admin` / `owner` / `master`，默认 `member` |
| `priority` | 升序优先级，数值越小越先匹配，默认 0 |
| `description` | 帮助与 WebUI 上展示的说明 |
| `usage` | 用法示例，例如 `"weather <城市>"` |
| `handler` | 命令处理函数 |

## handler 入参

```ts
ctx.command({
  name: "translate",
  match: /^翻译\s+(.+)$/,
  async handler({ ctx, event, command, text, body, args, match }) {
    // ctx       插件上下文
    // event     消息事件
    // command   当前注册的命令对象（只读）
    // text      消息的原始纯文本
    // body      去掉前缀后的文本
    // args      字符串参数数组
    // match     正则匹配结果（仅当 match 为正则时存在）
    await event.reply(`待翻译：${match?.[1] ?? args.join(" ")}`);
  },
});
```

## 正则与多前缀

需要更细的匹配时，把 `match` 换成正则：

```ts
ctx.command({
  name: "translate",
  match: /^翻译\s+(.+)$/,
  prefixes: [".", "/", "#"],
  description: "翻译文本",
});
```

`prefixes` 可以是单个前缀、字符串数组，或 `false`（不要前缀）。空字符串前缀 `""` 表示同时支持裸命令与带前缀命令，比如 `["#", "/", ""]` 可以命中 `#help`、`/help`、`help`。

### `prefixes: false` 与带点前缀

`prefixes: false` 表示**不强制要求前缀**——命令管理器会同时尝试「裸命令」与「带默认前缀」两种写法。`.weather` 和 `weather` 都能命中。

```ts
ctx.command({
  name: "weather",
  prefixes: false,
});
```

如果想限定具体允许哪些前缀（包括裸命令），用数组写法：

```ts
ctx.command({
  name: "weather",
  prefixes: ["", ".", "/"],   // weather / .weather / /weather 都命中
});
```

注意：

- `[""]` 与 `false` 在匹配上等价，但 `displayCommand` 区分——`false` 在帮助里展示为 `weather`（告诉用户这是裸命令），`[""]` 展示为 `.weather`
- 命令管理器按前缀长度倒序尝试剥除：长前缀优先（比如 `"/"` 优先于 `""`）

## aliases：让命令有多个入口

`aliases` 是字符串同义名数组，用于让同一 handler 响应多个名字。常见场景：

```ts
ctx.command({
  name: "weather",
  aliases: ["天气", "tq", "查天气"],
  description: "查询城市天气",
  handler: ({ event, args }) => event.reply(`查询 ${args.join(" ")}`),
});
```

`.weather`、`.天气`、`.tq`、`.查天气` 都会路由到同一个 handler。

`aliases` 与 `name` 的差异：

- **触发**：都生效，匹配顺序是 `match → name → aliases[0] → aliases[1] → ...`
- **展示**：帮助、WebUI 列表只展示 `name`，不展示别名
- **`id`**：永远等于 `name`（除非显式设置 `id`），别名不会变成独立的命令 id，因此 `access-control.json` 仍按 `name` 配置
- **正则命令不需要**：正则里用 `|` 分支或者 `match: /^天气|weather/`，效果一样

命令改名时把旧名放进 `aliases` 就能兼容老用户。

## 简写

只需要名字和处理器时可以直接传字符串或正则：

```ts
ctx.command("ping", ({ event }) => event.reply("pong"), {
  description: "连通性测试",
});

ctx.command(/^echo\s+(.+)$/, ({ event, match }) => event.reply(match![1]), {
  name: "echo",
  prefixes: ["."],
});
```

## 优先级与冲突

命令按 `priority` 升序选择（数值越小越先匹配），同优先级按注册顺序。首个匹配的命令会消费消息，通用命令放在较低优先级、专门命令放在较高优先级即可控制派发顺序。

```ts
ctx.command({
  name: "roll-d20",
  match: /^roll(?:\s+d(\d+))?$/i,
  priority: 10,
  description: "投骰子",
});

ctx.command({
  name: "roll-d6",
  match: /^roll\s+d6$/i,
  priority: 1, // 比 roll-d20 更小，先匹配
  description: "投六面骰",
});
```

## 权限

`permission` 决定谁能触发命令。`ctx.isMaster(event)` / `ctx.isOwner(event)` / `ctx.isAdmin(event)` 这套判断方法与 `permission` 语义对齐：

| 值 | 谁能触发 | 等价判断 |
| --- | --- | --- |
| `member` | 所有人 | （不检查） |
| `admin` | bot 主人、配置管理员、当前群群主或群管理员 | `ctx.isAdmin(event)` |
| `owner` | bot 主人或当前群群主 | `ctx.isOwner(event)` |
| `master` | 仅 bot 主人 | `ctx.isMaster(event)` |

`master` 是最高级，「bot 主人」指 `package.json` `mioku.owners` 里的 QQ 号。
`owner` 在 `master` 之上额外允许「当前群群主」，这样群主能在自己群里直接触发指令而无需在 owners 名单里。
`admin` 在 `owner` 之上还允许配置管理员（`mioku.admins`）与当前群管理员。

权限由命令管理器在派发时直接执行；插件代码里再写一次 `if (!ctx.isMaster(event))` 就是冗余。需要「CD 豁免」「二次确认」等非命令分支的判断时，再用 `ctx.isMaster` / `ctx.isOwner` / `ctx.isAdmin` 方法。

## 访问控制：access-control

角色之外还能按群、用户精细覆盖：`config/core/access-control.json`。命令管理器读取这份配置，按「用户 → 群 → 全局」的顺序合并规则；同一作用域里 `commands` 优先于 `plugins`。

```json
{
  "version": 1,
  "global": {
    "plugins": { "music": { "action": "block" } },
    "commands": {}
  },
  "groups": {
    "123456789": {
      "plugins": { "impact": { "action": "block" } },
      "commands": {
        "weather": {
          "上海天气": { "action": "allow" }
        }
      }
    }
  },
  "users": {
    "10001": {
      "commands": {
        "weather": {
          "查询": { "action": "block" }
        }
      }
    }
  }
}
```

`commands` 里的命令 id 就是 `ctx.command()` 注册时的 `id`（默认等于 `name`），例如 `weather`、`帮助菜单`。bot 主人、管理员、群主和群管理员绕过访问规则——但不会绕过命令自身的 `permission` 角色。

文件可以手工编辑，也可以在 WebUI 的访问控制页面里改，效果一致。

## 卸载

`ctx.command()` 返回注销函数，上下文在插件卸载时自动调用。如果在 `setup` 外面手动管理，记得在 cleanup 里调用。

## 不再推荐使用的插件元信息定义方式

`mioku.accessHooks` 与 `mioku.help` 是旧 manifest 兼容项，仍可读取，但：

- 新插件请把命令注册到 `setup` 里调用 `ctx.command()`，不要再写一遍前缀匹配与 `ctx.isMaster(event)` 闸门
- `mioku.help` 仅作为目录补充，不再是命令的主要来源
- `mioku.accessHooks` 仅用于没有迁移的旧插件的命令目录展示

不受支持的特性将在下一个主要版本更新中被移除。
