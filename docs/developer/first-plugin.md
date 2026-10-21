---
title: 第一个插件
description: 从零编写一个最小的 Mioku 插件，并逐段理解它的结构。
---

# 第一个插件

## 插件是什么

一个插件就是一个 `mioku-plugin-*` npm 包，或者本地 `plugins/` 目录下的一个文件夹。插件的核心是一个 `definePlugin` 对象。它声明自己的名字，然后在 `setup(ctx)` 中注册命令、事件监听和定时任务。框架加载插件时调用 `setup`，卸载时调用插件返回的清理函数。

## 最小插件

在项目的 `plugins/` 目录下新建文件夹 `hello`，在里面放一个 `index.ts`。

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

  async setup(ctx) {
    ctx.logger.info("hello 插件已加载");

    ctx.command({
      name: "hello",
      aliases: ["你好"],
      description: "打招呼",
      async handler({ event, args }) {
        const name = args.join(" ") || "世界";
        await event.reply(`你好，${name}`);
      },
    });

    // 返回清理函数，插件卸载时调用
    return () => {
      ctx.logger.info("hello 插件已卸载");
    };
  },
});
```

然后在 `package.json` 的 `mioku.plugins` 中启用它。

```json
{
  "mioku": {
    "plugins": ["hello"]
  }
}
```

执行 `bun run start`，在终端输入 `.hello` 试试。

```text
mioku> .hello
你好，世界
```

到这里就是一个完整的插件了。

## 逐段说明

`definePlugin` 是插件声明的入口，类型定义见 [MiokuPlugin](/reference/api/interfaces/MiokuPlugin)。它只要求一个 `name`，其余字段都是可选的。

| 字段 | 说明 |
| --- | --- |
| `name` | 插件唯一标识，必须与目录名或 npm 包短名一致，否则加载会报错 |
| `priority` | 加载优先级，数值越小越先加载，默认 100 |
| `dependencies` | 依赖的其他插件名 |
| `setup(ctx)` | 插件初始化逻辑，可以返回一个清理函数 |

版本号和描述写在 `package.json` 中，框架通过 `PluginMetadata` 统一读取，不需要在 `definePlugin` 中重复声明。

`ctx` 是插件上下文，常用的成员如下。

```typescript
ctx.command({ ... })                     // 注册消息命令，推荐用法
ctx.handle("notice", handler)            // 注册非命令事件监听
ctx.onBot("connected", ({ bot }) => ...) // 监听 bot 生命周期
ctx.logger.info("...")                   // 打印日志
ctx.text(event)                          // 提取消息纯文本
ctx.config                               // 框架配置
ctx.cron("0 9 * * *", handler)           // 注册定时任务
```

完整列表见 [MiokuContext](/reference/api/interfaces/MiokuContext)。

`event` 是事件对象。消息事件中最常用的是 `event.reply()`，用于回复消息。`event.message` 是消息内容，`event.user_id` 是发送者，`event.group_id` 是群号。命令注册和事件处理的细节见[事件处理](/developer/events)。

## 两种插件形态

插件有两种存放方式，效果相同。

- **本地插件**：放在项目 `plugins/` 目录，目录名可以用 `plugins_dir` 修改。开发调试使用这种方式，修改后重启即生效。
- **npm 插件**：发布成 `mioku-plugin-*` 包，用 `bun add` 安装，别人可以安装你的插件。

建议从本地插件开始编写，完成后再[发布](/developer/publish)。

## 下一步

- [事件处理](/developer/events)：路由怎么用，有哪些事件类型
- [命令管理器](/developer/commands)：命令的全部字段、优先级与权限
- [消息与消息段](/developer/message)：发送图片、@ 和引用
- [操作 Bot](/developer/bot)：禁言、查询群列表与多账号
