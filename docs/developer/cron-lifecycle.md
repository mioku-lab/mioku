# 定时任务与生命周期

插件不只能被动等消息：每天定时推天气、整点报时、到点清理缓存，都是定时任务的活。

## 定时任务：ctx.cron

一个每天早上 9 点问候群的插件：

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "morning",

  async setup(ctx) {
    ctx.cron("0 9 * * *", async (ctx, task) => {
      if (!ctx.bot) return; // 还没有 bot 在线，这轮先跳过
      await ctx.noticeGroups(["123456789"], "早上好！今天也要加油鸭～");
    });
  },
});
```

`ctx.cron(expression, handler)` 底层是 node-cron，两个参数：

| 参数 | 说明 |
| --- | --- |
| `expression` | cron 表达式，5 段（分 时 日 月 周）；前面多加一段表示秒 |
| `handler` | 到点执行的回调 |

handler 的第一个参数是 `ctx` 本身——就是 `setup` 收到的那个对象，框架原样传给你，所以 `ctx.noticeGroups`、`ctx.logger` 这些在定时任务里照用不误。第二个参数是 node-cron 的 `TaskContext`，想知道本次触发信息时才用得上：

| 字段 | 说明 |
| --- | --- |
| `task.date` | 本次触发对应的时间点 |
| `task.triggeredAt` | 实际触发的时间 |
| `task.dateLocalIso` | 本地时区的 ISO 时间字符串 |

常用表达式速查：

| 表达式 | 含义 |
| --- | --- |
| `0 9 * * *` | 每天 9:00 |
| `30 8 * * 1-5` | 工作日 8:30 |
| `0 */2 * * *` | 每两小时整点 |
| `0 22 * * 0` | 每周日 22:00 |
| `*/30 * * * * *` | 每 30 秒（六段写法） |

::: warning 表达式写错了当场就炸
`ctx.cron` 注册时会立刻校验表达式，不合法直接抛错，插件加载失败。别把表达式拼成运行时字符串还不测一把。
:::

## 手动控制任务

`ctx.cron` 返回一个 `ScheduledTask`（node-cron 的任务实例），想手动控制时接住它：

```typescript
const task = ctx.cron("0 9 * * *", async (ctx) => { /* ... */ });

task.stop();       // 暂停，不再触发
task.start();      // 恢复
task.getNextRun(); // 下次触发时间（Date），没有就返回 null
```

插件卸载时框架会自动停掉它注册的所有定时任务，所以大多数情况下这个返回值你根本用不着——只有运行中想暂停/恢复才需要。

## 插件的加载与卸载

框架加载插件时调用 `setup(ctx)`；被禁用、被 reload、进程退出时，框架会做清理。清理分两类：

- **框架替你记着的**：`ctx.handle` 注册的监听、`ctx.cron` 注册的任务、`ctx.addService` 注册的服务。插件卸载时自动取消/停止，不用管。
- **需要你收拾的**：外部数据库连接、临时文件、自己起的后台循环……这些在 `setup` 返回的清理函数里处理。

`ctx.handle` 的返回值本身就是取消函数，想在运行中提前取消也可以手动调：

```typescript
async setup(ctx) {
  const off = ctx.handle("message", async (event) => {
    if (ctx.text(event).includes("别听了")) {
      off(); // 立刻取消这个监听
    }
  });
}
```

完整的例子：启动时开定时任务和监听，卸载时清掉框架不知道的东西：

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
        await event.reply("好的，提醒已暂停");
      }
    });

    // 清理函数，也可以是 async；插件卸载时框架会等它跑完
    return () => {
      clearInterval(timer); // 框架不知道的 interval，得自己清
      // task 和监听框架会自动收拾，写不写都行
    };
  },
});
```

## 监听 bot 上下线

适配器连接、掉线时会派发 `bot:connected` / `bot:disconnected` 事件，`ctx.onBot` 是它们的快捷方式：

```typescript
ctx.onBot("connected", async ({ bot }) => {
  ctx.logger.info(`bot ${bot.bot_id} 上线了`);
  await bot.sendGroupMsg("87654321", `bot ${bot.bot_id} 已上线，随时待命`);
});

ctx.onBot("disconnected", ({ bot, reason }) => {
  ctx.logger.warn(`bot ${bot.bot_id} 掉线了：${reason ?? "未知原因"}`);
});
```

`connected` 的回调参数是 `{ bot }`，`disconnected` 多一个 `reason`。返回值同样是取消函数，一般用不着接。

## 生命周期事件

bot 上下线只是一部分，框架把启动过程的关键节点都做成了事件，用 `ctx.handle` 监听：

| 路由 | 什么时候派发 |
| --- | --- |
| `bot:connected` / `bot:disconnected` | bot 连接 / 断开 |
| `adapter:started` | 适配器启动成功 |
| `runtime:ready` | 所有适配器启动完成，框架就绪 |
| `runtime:shutdown` | 框架开始关闭 |

```typescript
ctx.handle("runtime:ready", () => {
  // 这时候 bot 列表是全的
  ctx.logger.info(`框架就绪，在线 bot：${ctx.bots.length} 个`);
});
```

## 踩坑：setup 时可能还没有 bot

框架的启动顺序是先加载插件、再启动适配器，也就是说 `setup` 执行时适配器还没启动，`ctx.bot` 大概率是 `undefined`：

```typescript
async setup(ctx) {
  // ❌ 这时候 bot 还没连上，发不出去
  await ctx.bot?.sendGroupMsg("123456789", "插件加载完成！");

  // ✅ 等 bot 上线再发
  ctx.onBot("connected", async ({ bot }) => {
    await bot.sendGroupMsg("123456789", "插件加载完成！");
  });
}
```

cron 任务同理：到点触发时 bot 可能刚好掉线。handler 里先判一下 `ctx.bot`，或者用 `ctx.noticeGroups`——没有 bot 在线时它发不出去（日志里有警告），但不会抛错。就算 handler 真的炸了也不要紧，框架会捕获并记日志，单次出错不影响下一次触发，也不影响其他插件。

## 下一步

- [事件处理](/developer/events) —— onBot 和生命周期事件背后的路由机制
- [配置与数据存储](/developer/config-data) —— 定时任务的推送目标、开关，都应该做成配置
- [第一个插件](/developer/first-plugin) —— 还没写过插件的话先看这篇
