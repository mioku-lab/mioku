# 消息与事件去重

Mioku 可能同时连接多个适配器，也可能在同一适配器中连接多个 Bot。相同的 QQ 消息因此可能被底层连接投递多次。为了避免插件重复执行，框架在**核心层**提供统一的事件关联与去重。

## 职责划分

| 层 | 职责 |
|---|---|
| 适配器 | **无损投递**。把平台事件翻译成统一的 `Event`，并把可用的强标识填进 `identity`（`message_id`、`native_event_id`、`timestamp` 等）。适配器不丢事件、不做去重判断。 |
| 核心 | **独占策略**。在传输边界登记事件关联，标记重复投递，并由每个 handler 决定是否吃重复。 |

去重必须放在核心，因为只有核心同时看得到「全部适配器」和「全部 handler」：适配器无法知道某个 handler 是否希望看到重复投递。适配器一旦先丢事件，`!` 注册的 handler 就再也拿不回那条投递。

## 处理流程

```text
平台事件
  ↓
适配器：构造统一 Event，填好 identity
  ↓
AdapterContext.dispatch()
  ├─ EventCorrelator.observe()   ← 关联登记 + 重复标记
  ├─ 运行时 Bot 循环保护
  └─ EventBus.dispatch()         ← 事件原样 fan-out
       └─ ctx.handle() 包装器
            ├─ 普通路由：跳过被标记为重复的投递
            └─ `!` 路由：不过滤，逐条投递都执行
```

## 关联器与去重键

跨适配器关联由 `EventCorrelator` 负责，它是 **runtime 单例**（不再每个 handler 各建一份），可在 `startRuntime` 配置中关闭：

```jsonc
// package.json
"mioku": { "dedup": { "cross_adapter": true } }
```

### 消息键

```text
m | 消息类型 | 会话标识 | 发送者标识 | 内容签名
```

- **会话标识**：群聊取 `group_id`，私聊取 `user_id`。这是为了避免「同一人在两个群发同样内容」被误判为重复。
- **发送者标识**：只使用强标识 `user_id`，**不使用昵称**。昵称会随群名片变化，且在不同适配器之间不稳定，作为身份会导致误杀与漏杀。
- **内容签名**：按段规范化。

### 内容签名

| 段类型 | 签名 |
|---|---|
| `text` | 文本内容（截断到 256 字符） |
| `at` | `@` 目标 ID |
| `face` | 表情 ID |
| `json` / `xml` / `ark` | 解析后做**稳定序列化**（对象键排序、忽略排版空白）再取哈希 |
| `image` / `flash` | 优先内容哈希（`md5`/`sha1`），其次文件名里嵌的 md5，再次规范化 URL |
| `video` / `record` / `file` | 只保留段类型 |
| `reply` | 不参与签名 |

结构化卡片（`json`/`xml`/`ark`）与图片使用摘要，是为了区分「同一人短时间内发了两张不同卡片 / 两张不同图片」；这类载荷在 OneBot 与 icqq 之间是一致的，因此摘要可以匹配。

`video` / `record` / `file` 目前只保留段类型：icqq 对视频/语音使用 `protobuf://…` 本地引用，而 OneBot 使用下载 URL，两端没有共享的内容哈希，强行加摘要反而会破坏跨适配器去重。

### 通知与请求键

通知与请求同样由关联器处理，键包含：

- `event_type`、`notice_type`/`request_type`、`sub_type`
- `group_id`、`user_id`、`operator_id`
- 事件时间

消息去重窗口为 **15 秒**，通知/请求为 **60 秒**。窗口内相同键的后续投递会被标记为重复；窗口过期后，同样内容可以再次处理。

### 已知边界

- **不做跨命名空间关联**：icqq / OneBot 使用 QQ 号，QQ 官方使用 openid，两者无法用同一套 ID 关联。框架不会用昵称去桥接它们，因此同一个人在 QQ 号体系与 openid 体系下会被视为两个发送者。
- 媒体摘要在两端都无法提供稳定标识时会退化为「只看段类型」，此时短时间内同类型的两条不同媒体可能被视为重复。
- `MAX_SIZE` 之外的关联组会按插入顺序淘汰，淘汰会记入 `evicted` 统计。

## handler 层

普通的 `ctx.handle()` 会读取关联器标记，跳过重复投递：

```ts
ctx.handle("message", async (event) => {
  // 同一条逻辑消息在去重窗口内只执行一次
});
```

### 绕过去重

在路由前加 `!` 即可绕过该 handler 的过滤：

```ts
ctx.handle("!message", async (event) => {
  // 每一条投递都会执行（包括被标记为重复的那些）
});

ctx.handle("!notice.group", async (event) => {
  // 每个群通知都会执行
});

ctx.handle("!request.friend", async (event) => {
  // 每个好友申请都会执行
});
```

如果传入路由数组，只要数组中有一个路由带 `!`，这次注册会整体绕过去重。建议不要在同一个数组中混合普通路由和绕过去重路由，直接拆成两次 `ctx.handle` 更清晰。

### 关联视图

即使某条投递被标记为重复，它的关联信息依然可读，插件可以据此实现「逐 Bot」语义：

```ts
// `!` 路由下可以拿到全部投递
ctx.handle("!message", async (event) => {
  // 同一条逻辑消息被哪些适配器/bot 投递过
  const record = ctx.correlation(event);
  const bots = ctx.botsForEvent(event);

  // 消息里 @ 到了哪些「本运行时已连接」的 bot
  const mentioned = ctx.mentionedBots(event);
});

// 普通路由下同样可用（关联信息与是否被过滤无关）
ctx.handle("message", async (event) => {
  const replyBot = ctx.pickReplyBot(event);
});

// 运行统计：groups / observed / duplicates / evicted
ctx.correlationStats();
```

需要「每个 bot 各处理一次」时，用 `!` 路由配合 `ctx.botsForEvent(event)` 自行按 bot 分发。

### 让「被 @ 的 bot」回应

跨适配器去重带有「首个到达者为 primary」的语义。如果用户 @ 的是 bot B，但 bot A 的事件先到，那么 `event.bot` / `event.self_id` 指向的是 **A**。只读 `event.bot` 的插件就会由 A 来回应，@B 看起来「没反应」。

核心提供 `ctx.pickReplyBot(event)` 来消除这个歧义，选取顺序是：

```text
被 @ 的、且本运行时已连接的 bot  →  关联组里首个到达的 bot（primary）  →  event.bot
```

内置的 chat 插件已经按这个顺序选角：即使 @ 的那台 bot 的事件在去重里「输」了，它依然会亲自回应。

## 与 WeakSet 去重的区别

`ctx.handle` 还有一层针对同一个 JavaScript 事件对象的 `WeakSet` 保护：

```text
同一个 Event 对象通过多个匹配路由到达同一个 handler
  → handler 只执行一次
```

它只识别「同一个对象实例」。不同适配器各自构造出的两个对象，即使内容完全相同，也必须依赖关联器的指纹去重。

`!message` 只绕过指纹过滤，仍然保留 WeakSet 保护。因此同一个 Event 对象重复 dispatch 时，单个 handler 仍不会执行两次。

`!` 不是权限控制，也不是循环保护开关。绕过去重后，插件必须自行保证幂等性，否则多个 Bot 的重复事件会真实执行多次。
