---
title: 消息与事件去重
description: Mioku 的跨适配器事件关联、去重键、绕过去重与关联视图。
---

# 消息与事件去重

Mioku 可能同时连接多个适配器，也可能在同一个适配器中连接多个 bot。同一条 QQ 消息因此可能被底层连接投递多次。为了避免插件重复执行，框架在核心层提供统一的事件关联与去重。

## 职责划分

| 层 | 职责 |
| --- | --- |
| 适配器 | **无损投递**。把平台事件翻译成统一的 `Event`，并把可用的强标识填进 `identity`，例如 `message_id`、`native_event_id` 和 `timestamp`。适配器不丢弃事件，也不做去重判断。 |
| 核心 | **独占策略**。在传输边界登记事件关联，标记重复投递，由每个 handler 决定是否接收重复。 |

去重必须放在核心，因为只有核心同时看得到全部适配器和全部 handler。适配器无法知道某个 handler 是否希望看到重复投递。适配器一旦先行丢弃事件，使用 `!` 注册的 handler 就再也拿不回那条投递。

## 处理流程

```text
平台事件
  ↓
适配器：构造统一 Event，填好 identity
  ↓
AdapterContext.dispatch()
  ├─ EventCorrelator.observe()   关联登记与重复标记
  ├─ 运行时 Bot 循环保护
  └─ EventBus.dispatch()         事件原样 fan-out
       └─ ctx.handle() 包装器
            ├─ 普通路由：跳过被标记为重复的投递
            └─ ! 路由：不过滤，逐条投递都执行
```

## 关联器与去重键

跨适配器关联由 `EventCorrelator` 负责。它是 runtime 单例，不再为每个 handler 各建一份，可以在 `startRuntime` 配置中关闭。

```jsonc
// package.json
"mioku": { "dedup": { "cross_adapter": true } }
```

### 消息键

```text
m | 消息类型 | 会话标识 | 发送者标识 | 内容签名
```

各部分含义如下。

- **会话标识**：群聊取 `group_id`，私聊取 `user_id`。这样可以避免同一人在两个群发送相同内容时被误判为重复。
- **发送者标识**：只使用强标识 `user_id`，不使用昵称。昵称会随群名片变化，在不同适配器之间也不稳定，作为身份会导致误杀与漏杀。
- **内容签名**：按消息段规范化后生成。

### 内容签名

| 段类型 | 签名 |
| --- | --- |
| `text` | 文本内容，截断到 256 字符 |
| `at` | at 目标的 ID |
| `face` | 表情 ID |
| `json` / `xml` / `ark` | 解析后做稳定序列化再取哈希，对象键排序并忽略排版空白 |
| `image` / `flash` | 优先取内容哈希 `md5` 或 `sha1`，其次是文件名中嵌入的 md5，最后是规范化 URL |
| `video` / `record` / `file` | 只保留段类型 |
| `reply` | 不参与签名 |

结构化卡片与图片使用摘要，是为了区分同一人在短时间内发送的两张不同卡片或两张不同图片。这类载荷在 OneBot 与 icqq 之间是一致的，因此摘要可以匹配。

`video`、`record` 和 `file` 目前只保留段类型。icqq 对视频和语音使用 `protobuf://` 本地引用，OneBot 使用下载 URL，两端没有共享的内容哈希。强行加入摘要反而会破坏跨适配器去重。

### 通知与请求键

通知与请求同样由关联器处理，键包含以下内容。

- `event_type`、`notice_type` 或 `request_type`、`sub_type`
- `group_id`、`user_id`、`operator_id`
- 事件时间

消息的去重窗口是 15 秒，通知和请求是 60 秒。窗口内相同键的后续投递会被标记为重复。窗口过期后，同样内容可以再次处理。

### 已知边界

- **不做跨命名空间关联**：icqq 与 OneBot 使用 QQ 号，QQ 官方使用 openid。两者无法用同一套 ID 关联。框架不会用昵称桥接它们。因此同一个人在 QQ 号体系与 openid 体系下会被视为两个发送者。
- 媒体摘要在两端都无法提供稳定标识时会退化为只看段类型，此时短时间内同类型的两条不同媒体可能被视为重复。
- 超出 `MAX_SIZE` 的关联组会按插入顺序淘汰，淘汰会记入 `evicted` 统计。

## handler 层

普通的 `ctx.handle()` 会读取关联器标记，跳过重复投递。

```typescript
ctx.handle("message", async (event) => {
  // 同一条逻辑消息在去重窗口内只执行一次
});
```

### 绕过去重

在路由前加 `!` 即可绕过该 handler 的过滤。

```typescript
ctx.handle("!message", async (event) => {
  // 每一条投递都会执行，包括被标记为重复的那些
});

ctx.handle("!notice.group", async (event) => {
  // 每个群通知都会执行
});

ctx.handle("!request.friend", async (event) => {
  // 每个好友申请都会执行
});
```

传入路由数组时，只要数组中有一个路由带 `!`，这次注册会整体绕过去重。建议不要把普通路由与绕过去重的路由放在同一个数组中，拆成两次 `ctx.handle` 更清晰。

### 关联视图

即使某条投递被标记为重复，它的关联信息依然可以读取，插件可以据此实现按 bot 处理的语义。

```typescript
// `!` 路由下可以拿到全部投递
ctx.handle("!message", async (event) => {
  // 同一条逻辑消息被哪些适配器或 bot 投递过
  const record = ctx.correlation(event);
  const bots = ctx.botsForEvent(event);

  // 消息中 at 到了哪些本运行时已连接的 bot
  const mentioned = ctx.mentionedBots(event);
});

// 普通路由下同样可用，关联信息与是否被过滤无关
ctx.handle("message", async (event) => {
  const replyBot = ctx.pickReplyBot(event);
});

// 运行统计：groups、observed、duplicates、evicted
ctx.correlationStats();
```

需要让每个 bot 各处理一次时，使用 `!` 路由配合 `ctx.botsForEvent(event)`，自行按 bot 分发。

### 让被 at 的 bot 回应

跨适配器去重带有首个到达者为 primary 的语义。如果用户 at 的是 bot B，但 bot A 的事件先到达，那么 `event.bot` 和 `event.self_id` 指向的是 A。只读取 `event.bot` 的插件就会由 A 来回应，看起来像是 at 了 B 却没有反应。

核心提供 `ctx.pickReplyBot(event)` 来消除这个歧义。选取顺序如下。

```text
被 at 的、且本运行时已连接的 bot  →  关联组中首个到达的 bot  →  event.bot
```

内置的 chat 插件已经按这个顺序选择回应者。即使被 at 的那台 bot 在去重中处于后到达的位置，它依然会亲自回应。

## 与 WeakSet 去重的区别

`ctx.handle` 还有一层针对同一个 JavaScript 事件对象的 WeakSet 保护。

```text
同一个 Event 对象通过多个匹配路由到达同一个 handler
  → handler 只执行一次
```

它只识别同一个对象实例。不同适配器各自构造出的两个对象，即使内容完全相同，也必须依赖关联器的指纹去重。

`!message` 只绕过指纹过滤，仍然保留 WeakSet 保护。因此同一个 Event 对象被重复 dispatch 时，单个 handler 仍不会执行两次。

`!` 不是权限控制，也不是循环保护开关。绕过去重后，插件必须自行保证幂等性，否则多个 bot 的重复事件会真实执行多次。

## 下一步

- [事件总线](/advanced/event-bus)：事件如何分发到 handler
- [事件处理](/developer/events)：路由与事件类型
- [EventCorrelator 类型参考](/reference/api/classes/EventCorrelator)：关联器的接口定义
