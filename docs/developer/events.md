---
title: 事件处理
description: Mioku 的事件路由、事件类型与监听方式。
---

# 事件处理

## 最小监听

```typescript
ctx.handle("message", async (event) => {
  // 处理所有消息
});
```

`message` 是最常用的事件，私聊和群聊都会触发。

## 路由

`handle` 的第一个参数是路由。路由是分层的，监听越具体，收到的事件越少。

| 路由 | 收到什么 |
| --- | --- |
| `message` | 所有消息 |
| `message.private` | 私聊消息 |
| `message.group` | 群聊消息 |
| `notice` | 所有通知 |
| `notice.<类型>` | 某一类通知，类型名由适配器决定 |
| `request` | 所有请求，包含加群和加好友 |
| `request.friend` | 好友请求 |
| `meta_event` | 生命周期事件 |

路由可以带上适配器名，精确到平台。

| 路由 | 收到什么 |
| --- | --- |
| `onebotv11:message.group` | 来自 onebotv11 的群消息 |
| `icqq:message.private` | 来自 icqq 的私聊消息 |

适配器生成事件时会构造一整套路由，监听其中任意一层都能收到事件。例如一条 onebotv11 的群消息会带上以下路由。

```text
onebotv11:message.group
onebotv11:message
onebotv11
message.group
message
```

`message` 能收到所有平台的消息，原因就是它匹配到了最粗的一层。

::: tip 一个 handler 监听多个路由
`handle` 支持传入数组，一次监听多个路由。

```typescript
ctx.handle(["message.group", "message.private"], async (event) => { ... });
```
:::

## 路由与类型推断

路由中带上适配器名不仅会收窄事件范围，还会改变事件的类型。`event.bot` 会被推断为对应适配器的 bot 类型，在编辑器中直接获得该平台专属方法的提示。

```typescript
ctx.handle("onebotv11:message.group", async (event) => {
  event.bot.getCookie("qun.qq.com");   // OneBot 特有方法
  event.bot.sendLike(event.user_id);
});

ctx.handle("icqq:message", async (event) => {
  event.bot.sendLike(event.user_id);   // IcqqBot 特有方法
  event.bot.pickGroup(event.group_id);
  event.bot.client;                    // 底层 icqq Client
});
```

## 事件类型

事件有五种 `kind`，对应不同的结构。

| kind | 类型 | 典型场景 |
| --- | --- | --- |
| `message` | [MessageEvent](/reference/api/interfaces/MessageEvent) | 私聊和群聊消息 |
| `notice` | [NoticeEvent](/reference/api/interfaces/NoticeEvent) | 群成员变动、戳一戳、文件上传 |
| `request` | [RequestEvent](/reference/api/interfaces/RequestEvent) | 加群和加好友申请 |
| `meta_event` | [MetaEvent](/reference/api/interfaces/MetaEvent) | 生命周期事件 |
| `adapter` | [AdapterEvent](/reference/api/interfaces/AdapterEvent) | 适配器自定义事件，包含 bot 连接和运行时就绪 |

### 消息事件

```typescript
ctx.handle("message", async (event) => {
  event.message;      // 消息内容，消息段数组
  event.raw_message;  // 原始文本
  event.message_type; // "private" 或 "group"
  event.user_id;      // 发送者
  event.group_id;     // 群号，群消息时存在
  event.sender;       // 发送者信息，包含昵称和角色
  event.is_to_me;     // 是否 at 了这条事件自己的那台 bot
  event.quote_id;     // 引用的消息 id，有引用时存在

  await event.reply("hello");  // 回复这条消息
  await event.recall();        // 撤回这条消息，部分平台支持
});
```

::: tip 多适配器与多 bot
`is_to_me` 只表示事件是否 at 到了这条事件自己的那台 bot。跨适配器去重之后，它可能并不是被 at 的那一台。

判断是否 at 到了本运行时的某台 bot 时，使用 `ctx.mentionedBots(event)`。决定由哪台 bot 回应时，使用 `ctx.pickReplyBot(event)`。详见[消息与事件去重](/advanced/event-dedup)。
:::

### 通知事件

```typescript
ctx.handle("notice", async (event) => {
  event.notice_type; // 通知大类，取值由适配器决定
  event.sub_type;    // 通知子类，取值由适配器决定
  event.user_id;     // 涉及的用户
  event.group_id;    // 涉及的群
});
```

不同适配器的 `notice_type` 与 `sub_type` 取值不同。onebotv11 把底层事件归一化成两段：群戳一戳的 `notice_type` 是 `group`，`sub_type` 是 `poke`，对应路由 `notice.group.poke`。判断之前需要先确认目标适配器的取值。

```typescript
ctx.handle("onebotv11:notice.group", async (event) => {
  if (event.sub_type === "poke" && event.user_id !== ctx.self_id) {
    await event.bot.sendGroupMsg(event.group_id, "已收到戳一戳");
  }
});
```

也可以直接监听具体路由，省去字段判断。

```typescript
ctx.handle("onebotv11:notice.group.poke", async (event) => {
  await event.bot.sendGroupMsg(event.group_id, "已收到戳一戳");
});
```

### 请求事件

请求事件可以直接同意或拒绝。

```typescript
ctx.handle("request.friend", async (event) => {
  if (event.comment?.includes("暗号")) {
    await event.approve();
  } else {
    await event.reject("请输入暗号");
  }
});
```

### 生命周期事件

bot 连接和运行时就绪这类事件使用 `adapter` kind 派发，路由是 `bot:connected`、`bot:disconnected`、`runtime:ready`、`adapter:started` 等。框架提供了便捷方法。

```typescript
ctx.onBot("connected", ({ bot }) => {
  ctx.logger.info(`bot ${bot.bot_id} 上线了`);
});

ctx.onBot("disconnected", ({ bot, reason }) => {
  ctx.logger.info(`bot ${bot.bot_id} 掉线了：${reason}`);
});
```

也可以直接监听路由。

```typescript
ctx.handle("runtime:ready", () => {
  // 框架启动完成，所有适配器都已就绪
});
```

## 事件中的 bot

每个事件都带有触发它的 `event.bot`，也就是处理这个事件的 bot 实例。多账号时这一点很重要，回复必须使用正确的 bot。

```typescript
ctx.handle("message", async (event) => {
  await event.bot.sendGroupMsg(event.group_id, "收到");
  await event.reply("收到");
});
```

## 优先级与认领

`definePlugin` 的 `priority` 决定 `handle` 监听器的执行顺序，数值小的插件先收到事件，同优先级按注册顺序。内置 core 插件的优先级是 `-Infinity`，总是最先执行。

监听器按顺序逐个执行，handler 的返回值决定要不要继续往下传。

| 返回值                    | 含义                                 |
|------------------------|------------------------------------|
| `undefined`（不写 return） | 不认领，继续交给后续监听器。这是默认行为               |
| `false`                | 不认领，与 `undefined` 同义，用于显式表达「这条不归我」 |
| `true`                 | 认领。派发到此结束，后续监听器不会收到                |

多个插件同时响应一条消息是正常用法，所以不写 return 不会截断别人。只有确实要独占这条消息时才 `return true`：

```typescript
ctx.handle("message.group", async (event) => {
  const match = ctx.text(event).match(/^打卡$/);
  if (!match) return false;       // 不归我，后面的人继续看
  await event.reply("打卡成功");
  return true;                    // 已处理，不必再传
});
```

## 事件总线

路由匹配和分发由 `EventBus` 实现，支持 `*` 通配符和按优先级分组，单个监听器出错只记日志、不影响后续监听器。命令管理器先于总线尝试匹配，认领的消息不再进入总线。

插件一般不需要直接使用 `EventBus`。想了解事件如何走到 handler，见[事件总线](/advanced/event-bus)。

## 下一步

- [命令管理器](/developer/commands)：注册消息命令
- [消息与消息段](/developer/message)：发送图片、@ 和引用
- [操作 Bot](/developer/bot)：主动发送消息与管理群
