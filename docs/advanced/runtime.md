---
title: 运行时生命周期
description: Mioku 的启动顺序、生命周期事件、关闭顺序与运行时对象。
---

# 运行时生命周期

框架从启动到退出会经历一系列阶段，每个阶段派发对应的事件。本章说明整个生命周期，用于判断某段逻辑应该挂在哪个时机。

## 启动顺序

```text
start()
 ├─ 读取 package.json 的 mioku 配置
 ├─ serviceManager.discoverServices()   发现服务，扫描 services/ 与 mioku-service-*
 ├─ startRuntime()
 │   ├─ 创建 Driver / EventBus / BotRegistry / CapabilityRegistry
 │   ├─ discoverAdapters()              发现适配器候选
 │   ├─ setupPlugins()
 │   │   ├─ 加载内置 core 插件
 │   │   └─ 按 priority 加载用户插件
 │   └─ 逐个 startAdapter()
 │       ├─ create(definition) → Adapter 实例
 │       └─ adapter.start(context)
 │           ├─ registerBot / registerCapability
 │           ├─ 派发 adapter:started
 │           └─ 派发 runtime:ready
 └─ 上线通知，online_push 打开时执行
```

有两点需要注意。

1. **插件先于适配器**：插件 `setup` 时还没有任何 bot 连接。要给 bot 发送消息，需要等 `bot:connected` 事件或 `runtime:ready` 事件。
2. **服务先于插件**：服务在 `startRuntime` 之前就加载完成，因此插件 `setup` 中调用 `getService` 一定拿得到，除非服务自身加载失败。

## 生命周期事件

以下事件都可以用 `ctx.handle()` 监听，路由直接使用。框架内部也依靠它们协作。

| 事件 | 时机 | 载荷 |
| --- | --- | --- |
| `adapter:started` | 每个适配器启动成功 | `{ name }` |
| `bot:connected` | 每个 bot 连接建立 | `{ bot }` |
| `bot:disconnected` | bot 断开 | `{ bot, reason? }` |
| `runtime:ready` | 所有适配器启动完毕 | 无 |
| `runtime:shutdown` | 开始关闭 | `{ reason? }` |

对应关系如下。

```typescript
ctx.handle("bot:connected", (event) => { ... });  // 等价于 ctx.onBot("connected", ...)
ctx.handle("runtime:ready", () => { ... });
```

## 关闭顺序

关闭由 SIGINT、SIGTERM 或调用 `stop()` 触发，顺序是启动的逆序。

1. 派发 `runtime:shutdown`。
2. 停止适配器，逐个调用 `stop(reason)`。
3. 释放适配器资源与网关。
4. 卸载插件，执行每个插件的清理函数并取消事件监听。
5. 清空能力注册表与 bot 注册表。
6. 调用 `driver.shutdown()`，停止服务并执行 `dispose`。

清理函数中不要执行耗时操作。框架的关闭超时是 15 秒，超时会强制退出。

## 运行时对象

整个运行时的核心是 [MiokuRuntime](/reference/api/classes/MiokuRuntime) 类。`start()` 入口创建它并持有 driver、bus、bots 和 capabilities 等全部状态。插件拿到的 `ctx` 是它的一个投影，也就是按插件视角裁剪过的只读窗口。

## 下一步

- [事件总线](/advanced/event-bus)：事件如何分发到 handler
- [驱动器](/advanced/driver)：适配器的网络出口
- [包发现与加载](/advanced/loader)：插件与适配器的加载流程
