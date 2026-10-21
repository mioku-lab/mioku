---
title: 消息与消息段
description: Mioku 的消息段结构、读取方式与构造方法。
---

# 消息与消息段

一条消息不是一个字符串，而是一串消息段 MessageSegment。文本、at、图片和引用各自有不同的类型和参数。

## 消息的结构

收到的事件中，`event.message` 是一个消息段数组。例如一条 at 了机器人的消息在 onebotv11 下是这样的。

```text
[
  { type: "at",      data: { qq: "12345" } },
  { type: "text",    data: { text: " 早啊" } }
]
```

每个消息段有 `type` 和 `data`。文本段最常见，`event.raw_message` 是所有文本段拼接的结果。

## 读取消息

取纯文本最常用，使用 `ctx.text()`。

```typescript
const text = ctx.text(event);   // "早啊"，默认去除每个文本段首尾的空白
```

按类型查找消息段。

```typescript
const ats = event.message.filterByType("at");        // 所有 at 段
const firstImage = event.message.find((s) => s.type === "image");
```

取第一个 at 段的目标。

```typescript
import { atOf } from "mioku";

const target = atOf(event.message);  // "12345" 或 undefined
```

## 构造消息段

`ctx.segment` 是消息段构造器，也可以从 `mioku` 导入 `segment`。常用方法如下。

```typescript
segment.text("hello")                          // 文本
segment.at("12345")                            // at 某人
segment.image("https://.../a.png")             // 图片，使用 URL
segment.image("/tmp/a.png", { local: true })   // 图片，使用本地路径
segment.image(buffer)                          // 图片，Buffer 自动转换为 base64
segment.reply("message_id")                    // 引用某条消息
segment.video(url)                             // 视频
segment.record(url)                            // 语音
segment.file(path)                             // 文件
segment.face("1")                              // 表情
segment.forward("forward_id")                  // 合并转发
segment.node({ user_id, nickname, content })   // 转发节点
segment.json({...})                            // JSON 卡片
segment.markdown("# 标题\n**markdown** 内容")  // markdown 消息
segment.button({ label, action, data })        // 交互按钮
segment.raw(type, data)                        // 任意原始段
```

::: tip 发送本地文件
本地路径需要加 `{ local: true }`，否则框架会把它当作 URL 发送给平台。`image` 传入 Buffer 时不需要该选项，框架会自动转换为 base64。
:::

## 拼接消息

发送接口包括 `event.reply`、`bot.sendMessage` 和 `bot.sendGroupMsg`。它们的入参 `MessageInput` 很宽容，字符串、单个消息段和消息段数组都可以。

```typescript
// 字符串
await event.reply("早上好");

// 多个消息段
await event.reply([
  segment.at(event.user_id),
  segment.text(" 早上好"),
]);

// 文本与表情
await event.reply([
  segment.text("查询完成："),
  segment.face("170"),
]);

// 图片与文字
await event.reply([
  segment.image("https://example.com/miku.png"),
  segment.text("\n这是我们的初音"),
]);
```

## 回复与引用

`event.reply()` 默认回复原消息并带引用，第二个参数控制是否引用。

```typescript
await event.reply("收到");        // 带引用回复
await event.reply("收到", false); // 不带引用，直接发送
```

引用任意一条历史消息时，先构造引用段。

```typescript
const quote = segment.reply("some_message_id");
await event.bot.sendGroupMsg(event.group_id, [quote, segment.text("你说得对")]);
```

## 常用模式

配合 `ctx.text()` 判断并回复。

```typescript
ctx.handle("message", async (event) => {
  const text = ctx.text(event);

  if (text === "帮助") {
    await event.reply("输入 /天气 <城市> 查天气");
    return;
  }

  const m = text.match(/^\/天气\s+(.+)$/);
  if (m) {
    await event.reply(`${m[1]}：晴，26°C`);
  }
});
```

`ctx.match()` 是更省事的键值路由，适合关键词场景。

```typescript
ctx.handle("message", async (event) => {
  await ctx.match(event, {
    "ping": "pong",
    "/天气/*": async (matches, e) => `天气信息：${matches[0]}`,
    "/^roll$/": () => String(Math.floor(Math.random() * 100) + 1),
  });
});
```

`match` 的键支持三种形式：纯文本精确匹配、`*` 通配符和 `/正则/`。命中后字符串会直接回复，函数会被执行，函数的第一个参数是匹配结果。`match` 默认带引用回复，第二个参数传 `false` 可以关闭。

## 下一步

- [操作 Bot](/developer/bot)：主动发送消息与管理群
- [事件处理](/developer/events)：消息事件包含哪些字段
- [命令管理器](/developer/commands)：把消息处理注册成命令
