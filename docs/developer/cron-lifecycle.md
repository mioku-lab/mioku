---
title: 定时任务与生命周期
description: 使用 ctx.cron 注册定时任务，并处理插件的加载、卸载与 bot 上下线。
---

# 定时任务与生命周期

插件不只能被动等待消息。每天定时推送天气、整点报时和到点清理缓存都属于定时任务。

## 定时任务

下面是一个每天早上 9 点问候群成员的插件。

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "morning",

  async setup(ctx) {
    ctx.cron("0 9 * * *", async (ctx) => {
      if (!ctx.bot) return; // 还没有 bot 在线，本轮跳过
      await ctx.noticeGroups(["123456789"], "早上好");
    });
  },
});
```

`ctx.cron(expression, handler)` 底层是 node-cron，接受两个参数。

| 参数 | 说明 |
| --- | --- |
| `expression` | cron 表达式，5 段表示分、时、日、月、周，前面多加一段表示秒 |
| `handler` | 到点执行的回调 |

handler 的第一个参数是 `ctx` 本身，也就是 `setup` 收到的那个对象。框架原样传入，因此 `ctx.noticeGroups` 和 `ctx.logger` 在定时任务中同样可用。第二个参数是 node-cron 的 `TaskContext`，需要了解本次触发信息时才用到。

| 字段 | 说明 |
| --- | --- |
| `task.date` | 本次触发对应的时间点 |
| `task.triggeredAt` | 实际触发的时间 |
| `task.dateLocalIso` | 本地时区的 ISO 时间字符串 |

常用表达式如下。

| 表达式 | 含义 |
| --- | --- |
| `0 9 * * *` | 每天 9:00 |
| `30 8 * * 1-5` | 工作日 8:30 |
| `0 */2 * * *` | 每两小时整点 |
| `0 22 * * 0` | 每周日 22:00 |
| `*/30 * * * * *` | 每 30 秒，六段写法 |

::: warning 表达式在注册时校验
`ctx.cron` 注册时会立即校验表达式，不合法会直接抛错并导致插件加载失败。不要把表达式拼接成运行时字符串。
:::

## 手动控制任务

`ctx.cron` 返回一个 `ScheduledTask`，也就是 node-cron 的任务实例。需要手动控制时接住它。

```typescript
const task = ctx.cron("0 9 * * *", async (ctx) => { /* ... */ });

task.stop();       // 暂停，不再触发
task.start();      // 恢复
task.getNextRun(); // 下次触发时间，没有则返回 null
```

插件卸载时框架会自动停止它注册的所有定时任务，因此大多数情况下不需要使用返回值。只有需要在运行中暂停或恢复时才需要。

## 插件的加载与卸载

框架加载插件时调用 `setup(ctx)`。插件被禁用、被重载或进程退出时，框架会执行清理。清理分两类。

- **框架负责的**：`ctx.handle` 注册的监听、`ctx.cron` 注册的任务和 `ctx.addService` 注册的服务。插件卸载时自动取消或停止。
- **插件负责的**：外部数据库连接、临时文件和自行启动的后台循环。这些需要在 `setup` 返回的清理函数中处理。

`ctx.handle` 的返回值本身就是取消函数，需要在运行中提前取消时可以直接调用。

```typescript
async setup(ctx) {
  const off = ctx.handle("message", async (event) => {
    if (ctx.text(event).includes("停止提醒")) {
      off(); // 立即取消这个监听
    }
  });
}
```

完整示例如下。启动时创建定时任务和监听，卸载时清理框架不知道的资源。

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "reminder",

  async setup(ctx) {
    const timer = setInterval(() => {
      ctx.logger.debug("reminder 心跳");
    }, 60_000);

    const task = ctx.cron("0 9 * * *", async (ctx) => {
      await ctx.noticeGroups(["123456789"], "记得喝水");
    });

    ctx.handle("message", async (event) => {
      if (ctx.text(event).trim() === "暂停提醒") {
        task.stop();
        await event.reply("提醒已暂停");
      }
    });

    // 清理函数，可以是 async。插件卸载时框架会等它执行完成
    return () => {
      clearInterval(timer); // 框架不知道的 interval，需要自行清理
    };
  },
});
```

## 监听 bot 上下线

适配器连接和掉线时会派发 `bot:connected` 与 `bot:disconnected` 事件，`ctx.onBot` 是它们的快捷方式。

```typescript
ctx.onBot("connected", async ({ bot }) => {
  ctx.logger.info(`bot ${bot.bot_id} 上线了`);
  await bot.sendGroupMsg("87654321", `bot ${bot.bot_id} 已上线`);
});

ctx.onBot("disconnected", ({ bot, reason }) => {
  ctx.logger.warn(`bot ${bot.bot_id} 掉线了：${reason ?? "未知原因"}`);
});
```

`connected` 的回调参数是 `{ bot }`，`disconnected` 多一个 `reason`。返回值同样是取消函数，一般不需要接住。

## 生命周期事件

bot 上下线只是其中一部分。框架把启动过程的关键节点都做成了事件，用 `ctx.handle` 监听。

| 路由 | 派发时机 |
| --- | --- |
| `bot:connected` / `bot:disconnected` | bot 连接或断开 |
| `adapter:started` | 适配器启动成功 |
| `runtime:ready` | 所有适配器启动完成，框架就绪 |
| `runtime:shutdown` | 框架开始关闭 |

```typescript
ctx.handle("runtime:ready", () => {
  // 此时 bot 列表是完整的
  ctx.logger.info(`框架就绪，在线 bot ${ctx.bots.length} 个`);
});
```

## setup 阶段没有 bot

框架的启动顺序是先加载插件再启动适配器。`setup` 执行时适配器尚未启动，`ctx.bot` 大概率是 `undefined`。

```typescript
async setup(ctx) {
  // 错误：此时 bot 还没连上，消息发送不出去
  await ctx.bot?.sendGroupMsg("123456789", "插件加载完成");

  // 正确：等 bot 上线后再发送
  ctx.onBot("connected", async ({ bot }) => {
    await bot.sendGroupMsg("123456789", "插件加载完成");
  });
}
```

定时任务同理。到点触发时 bot 可能刚好掉线，handler 中应先判断 `ctx.bot`。使用 `ctx.noticeGroups` 时，没有 bot 在线会发送失败并记录警告，但不会抛错。即使 handler 抛出异常，框架也会捕获并记录日志，单次出错不影响下一次触发，也不影响其他插件。

## 下一步

- [事件处理](/developer/events)：onBot 与生命周期事件的路由
- [配置与数据存储](/developer/config-data)：把推送目标和开关做成配置
- [第一个插件](/developer/first-plugin)：编写你的第一个插件
