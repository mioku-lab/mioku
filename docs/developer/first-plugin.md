---
title: 第一个插件
description: 手把手教你写一个 Mioku 插件
---

# 第一个插件

## 插件是什么

一个插件就是一个 `mioku-plugin-*` npm 包（或者本地 `plugins/` 目录下的一个文件夹），核心是一个 `definePlugin` 对象。它声明自己的名字，然后在 `setup(ctx)` 里注册命令、事件监听、定时任务等等。框架加载插件时调用 `setup`，卸载时调用你返回的清理函数。

## 最小插件

在你的项目 `plugins/` 目录下建一个文件夹 `hello`，里面放一个 `index.ts`：

```text
my-bot/
├── package.json
├── app.ts
└── plugins/
    └── hello/
        └── index.ts
```

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "hello",
  version: "1.0.0",

  async setup(ctx) {
    ctx.logger.info("hello 插件已加载");

    ctx.command({
      name: "hello",
      aliases: ["你好"],
      description: "打招呼",
      async handler({ event, args }) {
        const name = args.join(" ") || "世界";
        await event.reply(`你好呀，${name}，我是 Mioku 哒～`);
      },
    });

    // 返回清理函数，插件卸载时调用
    return () => {
      ctx.logger.info("hello 插件已卸载");
    };
  },
});
```

然后在 `package.json` 的 `mioku.plugins` 里启用它：

```json
{
  "mioku": {
    "plugins": ["hello"]
  }
}
```

`bun run start`，在终端（stdin）里输入「.hello」试试：

```text
mioku> .hello
你好呀，世界，我是 Mioku 哒～
```

这就是一个完整的插件了。

## 逐段拆解

**`definePlugin`** 是插件声明的入口，类型定义在[类型参考](/reference/api/interfaces/MiokuPlugin)里。它只要求一个 `name`，其余都是可选的：

| 字段            | 说明                                    |
|---------------|---------------------------------------|
| `name`        | 插件唯一标识，**必须和目录名 / npm 包短名一致**，否则加载会报错 |
| `version`     | 版本号                                   |
| `priority`    | 加载优先级，数值越小越先加载，默认 100                 |
| `description` | 描述                                    |
| `setup(ctx)`  | 插件初始化逻辑，可以返回一个清理函数                    |

**`ctx`** 是插件上下文，最常用的几个：

```typescript
ctx.command({ ... })                // 注册消息命令（推荐用法）
ctx.handle("notice.group.poke", h)  // 注册非命令事件监听
ctx.onBot("connected", ({ bot }) => ...) // 监听 bot 生命周期
ctx.logger.info("...")              // 打印日志
ctx.text(event)                     // 提取消息纯文本
ctx.config                          // 框架配置
ctx.cron("0 9 * * *", fn)           // 定时任务
```

完整列表见[类型参考](/reference/api/interfaces/MiokuContext)。

**`event`** 是事件对象。`message` 事件里最常用的是 `event.reply()`（回复消息）、`event.message`（消息内容）、`event.user_id` / `event.group_id`（发送者）。命令注册和事件处理在[下一章](/developer/events)详细讲。

## 两种插件形态

插件有两种放法，效果一样：

- **本地插件**：放在项目 `plugins/` 目录（默认，可用 `plugins_dir` 改），开发调试用这个，改完重启即生效
- **npm 插件**：发布成 `mioku-plugin-*` 包，`bun add` 安装，别人能装你的插件

从本地插件开始写，写好了再[发布](/developer/publish)。

## 下一步

- [事件处理](/developer/events) —— handle 的路由怎么用，有哪些事件类型
- [命令管理器](/developer/commands) —— `ctx.command()` 的全部字段、优先级、权限
- [消息与消息段](/developer/message) —— 发图片、@、引用等复杂消息
- [操作 Bot](/developer/bot) —— 禁言、查群列表、多账号
