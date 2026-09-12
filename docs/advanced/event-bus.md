# 事件总线

插件的 `ctx.handle()` 背后是 `EventBus` —— 框架内部唯一的事件分发器。插件一般碰不到它（`ctx.buses` 能拿到，但很少直接用），不过理解了它的匹配规则，你就能解释很多"为什么这个 handler 收到了事件"的问题。

## 分发流程

一个事件被 `bus.dispatch(event)` 派发后，总线做三件事：

1. **匹配**：遍历所有注册的监听器，找出路由与事件匹配的
2. **分组**：按优先级分组，数值小的先执行
3. **执行**：同组内按注册顺序，`Promise.allSettled` 并发执行——单个监听器抛错不会影响其他人

```typescript
const matched = this.#matching(event);
const priorityGroups = groupByPriority(matched);
for (const [priority, regs] of sorted(priorityGroups)) {
  await Promise.allSettled(regs.map((reg) => reg.handler(event)));
}
```

## 匹配规则

监听器注册的路由（pattern）和事件携带的路由列表（`event.routes`）做匹配，命中任意一条即可。

**精确匹配**：`pattern === route`。

**通配符**：`*` 单独一个通配所有；`message.*` 这种以 `*.` 结尾的 pattern 匹配 `message` 本身和它下面所有子路由。

| pattern | 能匹配到的事件路由 |
| --- | --- |
| `message` | `message` |
| `message.*` | `message`、`message.group`、`message.group.poke` 等所有 `message` 开头的 |
| `*` | 一切 |
| `onebotv11:message.group` | 恰好 `onebotv11:message.group` |

事件携带的路由列表由适配器构造事件时生成（`buildRoutes`），一条 onebotv11 群消息带 5 条路由（从最细到最粗），所以监听 `message` 也能收到它。这就是"粗路由通吃所有平台"的原理。

## 优先级与顺序

监听器的执行顺序由两个数字决定：

- **priority**：`ctx.handle` 的 options 里可传，插件默认用 `definePlugin` 的 `priority`（默认 100，core 插件是 `-Infinity` 所以最先）。数值小先执行。
- **order**：注册序号，同优先级内按注册先后。

框架内置 core 插件把 access 检查挂在最前面，靠的就是 `-Infinity` 优先级——它先看到事件，拦截掉不该放行的，后面的插件就不会收到。

## 监听器生命周期

`bus.register(route, handler, options)` 返回取消函数。`ctx.handle` 内部就是这么注册的，并把取消函数存进上下文的清理列表——插件卸载时所有监听自动移除。

```typescript
const off = bus.register("message", handler, {
  source: "plugin:my-plugin",  // 出错的日志里会带这个标识
  priority: 10,
});
off(); // 取消注册
```

## 事件去重

`ctx.handle` 除了用 WeakSet 防止同一个事件对象重复执行，还会跳过被核心关联器标记为「跨 Bot/适配器重复」的投递。适配器只负责无损投递并填好 `identity`，去重策略完全由核心持有；需要逐条处理时，可以用 `ctx.handle("!message", handler)` 绕过过滤，并用 `ctx.botsForEvent(event)` 拿到全部参与方。完整规则见[消息与事件去重](/advanced/event-dedup)。
