# 事件处理

## 最小监听

```typescript
ctx.handle("message", async (event) => {
  // 所有消息
});
```

`message` 是最常用的事件，私聊和群聊都会触发。

## 路由：从粗到细

`handle` 的第一个参数是路由。路由是分层的，监听越具体，收到的事件越少：

| 路由 | 收到什么 |
| --- | --- |
| `message` | 所有消息 |
| `message.private` | 私聊消息 |
| `message.group` | 群聊消息 |
| `notice` | 所有通知 |
| `notice.group` | 群通知 |
| `request` | 所有请求（加群/好友） |
| `request.friend` | 好友请求 |
| `meta_event` | 生命周期事件 |

还想更细？路由可以带上适配器名，精确到平台：

| 路由 | 收到什么 |
| --- | --- |
| `onebotv11:message.group` | 来自 onebotv11 的群消息 |
| `icqq:message.private` | 来自 icqq 的私聊消息 |

适配器生成事件时会构造一整套路由，监听其中任意一层都能收到事件。比如一条 onebotv11 的群消息会带上：

```text
onebotv11:message.group
onebotv11:message
onebotv11
message.group
message
```

这就是为什么 `message` 能收到所有平台的消息——它匹配到了最粗的那层。

::: tip 一个 handler 听多个路由
`handle` 支持传数组，一次监听多个路由：

```typescript
ctx.handle(["message.group", "message.private"], async (event) => { ... });
```
:::

## 路由与类型推断

路由里带上适配器名不只是为了收窄事件，还会**改变事件的类型**——`event.bot` 会被推断成对应适配器的 bot 类型，IDE 里直接就有那个平台的专属方法提示：

```typescript
ctx.handle("onebotv11:message.group", async (event) => {
  event.bot.getCookie("qun.qq.com");   // ✅ OneBot 特有方法
  event.bot.sendLike(event.user_id);   // ✅
});

ctx.handle("icqq:message", async (event) => {
  event.bot.sendLike(event.user_id);   // ✅ IcqqBot 特有方法
  event.bot.pickGroup(event.group_id); // ✅
  event.bot.client;                    // ✅ 底层 icqq Client
});
```

## 事件类型

事件有五种 `kind`，对应不同的事件结构：

| kind | 类型 | 典型场景 |
| --- | --- | --- |
| `message` | [MessageEvent](/reference/api/interfaces/MessageEvent) | 私聊/群聊消息 |
| `notice` | [NoticeEvent](/reference/api/interfaces/NoticeEvent) | 群成员变动、戳一戳、文件上传 |
| `request` | [RequestEvent](/reference/api/interfaces/RequestEvent) | 加群/好友申请 |
| `meta_event` | [MetaEvent](/reference/api/interfaces/MetaEvent) | 生命周期事件 |
| `adapter` | [AdapterEvent](/reference/api/interfaces/AdapterEvent) | 适配器自定义事件（含 bot 连接、运行时就绪） |

### 消息事件（message）

```typescript
ctx.handle("message", async (event) => {
  event.message;      // 消息内容（消息段数组）
  event.raw_message;  // 原始文本
  event.message_type; // "private" | "group"
  event.user_id;      // 发送者
  event.group_id;     // 群号（群消息时）
  event.sender;       // 发送者信息（昵称、角色）
  event.is_to_me;     // 适配器原生判断：是否 at 了「这条事件自己那台 bot」
  event.quote_id;     // 引用的消息 id（有引用时）

  // 回复这条消息
  await event.reply("hello");

  // 撤回这条消息（部分平台支持）
  await event.recall();
});
```

> 多适配器 / 多 bot 场景下，「是否 @ 到了本运行时的某台 bot」应该用 `ctx.mentionedBots(event)`，
> 「该由哪台 bot 回应」应该用 `ctx.pickReplyBot(event)`。`is_to_me` 只描述「这条事件自己那台 bot」，
> 跨适配器去重后它可能并不是被 @ 的那一台。详见[消息与事件去重](/advanced/event-dedup)。

### 通知事件（notice）

```typescript
ctx.handle("notice", async (event) => {
  event.notice_type; // 如 group_increase（入群）、group_poke（戳一戳）
  event.user_id;     // 涉及的用户
  event.group_id;    // 涉及的群
});
```

不同 `notice_type` 的字段不一样，处理前先判断：

```typescript
ctx.handle("notice.group", async (event) => {
  if (event.notice_type === "group_poke" && event.user_id !== ctx.self_id) {
    await event.bot.sendGroupMsg(event.group_id, "别戳了别戳了");
  }
});
```

### 请求事件（request）

请求事件可以直接同意或拒绝：

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

bot 连接、运行时就绪这类事件用 `adapter` kind 派发，路由是 `bot:connected`、`bot:disconnected`、`runtime:ready`、`adapter:started` 等。框架为此提供了便捷方法：

```typescript
ctx.onBot("connected", ({ bot }) => {
  ctx.logger.info(`bot ${bot.bot_id} 上线了`);
});

ctx.onBot("disconnected", ({ bot, reason }) => {
  ctx.logger.info(`bot ${bot.bot_id} 掉线了：${reason}`);
});
```

也可以直接监听路由：

```typescript
ctx.handle("runtime:ready", () => {
  // 框架启动完成，此时所有适配器都已就绪
});
```

## 事件里拿到 bot

每个事件都带着触发它的 `event.bot`——处理这个事件的 bot 实例。多账号时这很重要，回复要用对 bot：

```typescript
ctx.handle("message", async (event) => {
  // 用触发事件的 bot 回复
  await event.bot.sendGroupMsg(event.group_id, "收到");

  // 或者直接 event.reply()
  await event.reply("收到");
});
```

## 优先级

`definePlugin` 的 `priority` 会影响 `handle` 注册的事件监听顺序：数值小的插件先收到事件。同优先级按注册顺序。框架内置 core 插件优先级是 `-Infinity`，总是最先处理。

命令的优先级独立于插件——它由命令管理器在事件总线前选择首个匹配项，详见[命令管理器](/developer/commands)。

## 事件总线（进阶）

路由匹配和分发由 `EventBus` 实现，支持 `*` 通配符、按优先级分组、单个监听器出错不影响其他监听器。命令管理器在事件进入总线之前先消费已匹配的命令，因此 `handle` 不会重复处理已经被命令处理过的消息。插件一般用不到 `EventBus`，但想知道事件是怎么走到你的 handler 的，看[深入机制-事件总线](/advanced/event-bus)。

## 下一步

- [命令管理器](/developer/commands) —— 用 `ctx.command()` 注册消息命令
- [消息与消息段](/developer/message) —— 消息里的消息段怎么用、怎么发复杂消息
- [操作 Bot](/developer/bot) —— 主动发消息、管理群
