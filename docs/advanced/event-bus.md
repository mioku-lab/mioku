---
title: 事件总线
description: Mioku 事件总线的分发流程、匹配规则、优先级与过滤机制。
---

# 事件总线

`ctx.handle()` 背后是 `EventBus`，它是框架内部唯一的事件分发器。插件一般不会直接使用它，`ctx.buses` 可以拿到，但很少需要。理解它的匹配规则之后，就能解释很多关于 handler 为什么收到事件的问题。

通过 `ctx.command()` 注册的消息命令会在事件进入总线之前由命令管理器优先匹配。命中的命令会消费该消息，未命中的消息与非消息事件才进入总线。

## 分发流程

一个事件被 `bus.dispatch(event)` 派发后，总线执行三件事。

1. **过滤**：命令管理器先判断这个事件是否已被命令消费。`setFilter` 钩子按注册源决定是否让监听器看到该事件。
2. **匹配**：遍历所有已注册的监听器，找出路由与事件匹配的部分。
3. **分组与执行**：按优先级分组，数值小的先执行。同组内按注册顺序，使用 `Promise.allSettled` 并发执行，单个监听器抛错不会影响其他监听器。

```typescript
const matched = this.#matching(event);
const priorityGroups = groupByPriority(matched);
for (const [priority, regs] of sorted(priorityGroups)) {
  await Promise.allSettled(regs.map((reg) => reg.handler(event)));
}
```

## 匹配规则

监听器注册的路由 pattern 与事件携带的路由列表 `event.routes` 做匹配，命中任意一条即可。

**精确匹配**：pattern 与 route 完全相等。

**通配符**：`*` 单独使用表示匹配全部。以 `*.` 结尾的 pattern，例如 `message.*`，匹配 `message` 本身和它下面所有子路由。

| pattern | 能匹配到的事件路由 |
| --- | --- |
| `message` | `message` |
| `message.*` | `message`、`message.group`、`message.group.poke` 等所有以 `message` 开头的路由 |
| `*` | 一切 |
| `onebotv11:message.group` | 恰好是 `onebotv11:message.group` |

事件携带的路由列表由适配器构造事件时生成，生成函数是 `buildRoutes`。一条 onebotv11 群消息带 5 条路由，顺序是从最细到最粗，因此监听 `message` 也能收到它。粗路由能接收到所有平台的事件，原理就在这里。

## 优先级与顺序

监听器的执行顺序由两个数字决定。

- **priority**：可以在 `ctx.handle` 的 options 中传入，插件默认使用 `definePlugin` 的 `priority`，默认值是 100。core 插件是 `-Infinity`，因此总是最先执行。数值小的先执行。
- **order**：注册序号，同优先级内按注册先后排列。

命令的 `priority` 使用同样的升序规则，但命令会在进入事件总线之前独立选择首个匹配项。命中的命令会消费该消息，监听器收不到它。命令和监听器的优先级互不影响。

## 注册源过滤

总线支持通过 `setFilter` 注入全局过滤钩子。命令管理器使用这个机制按插件来源判定事件是否对该插件可见。

```typescript
bus.setFilter((registration, event) => {
  // 返回 false 即跳过该监听器
  return commands.shouldDispatch(registration.source, event);
});
```

`shouldDispatch` 的行为如下。

- 让主人、管理员、群主和群管理员的事件默认放行。
- 检查旧插件的 `mioku.accessHooks` 钩子，或 `ctx.command()` 注册的命令是否命中。
- 命中后查询 `config/core/access-control.json` 中的规则。

这意味着即使一个插件注册了 `ctx.handle("message")`，访问控制系统仍然可以按消息内容或事件路由拦截它。详细规则见[权限与访问控制](/developer/permissions)。

## 监听器生命周期

`bus.register(route, handler, options)` 返回取消函数。`ctx.handle` 内部就是这样注册的，并把取消函数存入上下文的清理列表。插件卸载时所有监听会自动移除。

```typescript
const off = bus.register("message", handler, {
  source: "plugin:my-plugin",  // 出错日志中会带这个标识
  priority: 10,
});
off(); // 取消注册
```

## 事件去重

`ctx.handle` 除了使用 WeakSet 防止同一个事件对象重复执行，还会跳过被核心关联器标记为跨 bot 或跨适配器重复的投递。适配器只负责无损投递并填好 `identity`，去重策略完全由核心持有。需要逐条处理时，可以用 `ctx.handle("!message", handler)` 绕过过滤，并用 `ctx.botsForEvent(event)` 拿到全部参与方。完整规则见[消息与事件去重](/advanced/event-dedup)。

## 下一步

- [消息与事件去重](/advanced/event-dedup)：跨适配器的重复投递处理
- [权限与访问控制](/developer/permissions)：注册源过滤的规则来源
- [包发现与加载](/advanced/loader)：插件如何注册监听
