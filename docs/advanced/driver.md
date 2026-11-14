---
title: 驱动器
description: Mioku 驱动器提供的 HTTP 与 WebSocket 客户端抽象。
---

# 驱动器

适配器要连接平台、要发送请求，需要一个网络出口。这个出口就是驱动器 Driver，它是框架提供的 HTTP 与 WebSocket 客户端抽象。

## 作用

适配器通过 `context.getDriver()` 获取驱动器，使用它的 `http` 和 `websocket` 两个客户端。

```typescript
const driver = context.getDriver();

// HTTP 请求
const res = await driver.http.request({
  method: "GET",
  url: "https://api.example.com/status",
});
const data = res.json();

// WebSocket 连接
const ws = await driver.websocket.connect("ws://localhost:3001", {
  headers: { Authorization: "Bearer token" },
  connectTimeout: 10_000,
});
```

[Driver 接口](/reference/api/interfaces/Driver) 定义在 `packages/mioku/src/driver/`。默认实现是 `createDefaultDriver`，内部使用 fetch 与 WebSocket，也就是 Node 22 的原生能力，并带有超时与关闭保护。

## 为什么需要这一层

驱动器把网络访问集中到一层，有三个好处。

1. **可替换**：驱动器的实现可以整体替换。例如换成自定义的代理、TLS 配置或网络策略，适配器代码不需要修改。
2. **统一超时与错误**：`WebSocketConnectTimeoutError` 和 `HttpRequestError` 这类错误类型统一，适配器处理网络问题有统一依据。
3. **生命周期一致**：框架关闭时会调用 `driver.shutdown()`，所有连接统一清理，适配器不需要自行管理。

## 适配器中的用法

适配器获取驱动器的标准写法如下。

```typescript
import type { Adapter, AdapterContext, Logger, WebSocketConnection } from "mioku";

const build = (config: MyConfig, logger: Logger): Adapter => {
  let ws: WebSocketConnection | undefined;
  let stopping = false;

  const connect = async (context: AdapterContext): Promise<void> => {
    ws = await context.getDriver().websocket.connect(config.url, {
      connectTimeout: 15_000,
    });

    // 接收消息
    ws.onMessage((data) => {
      const event = parseEvent(data);
      if (event) void context.dispatch(event);
    });

    // 断线重连
    ws.onClose(() => {
      if (!stopping) void connect(context);
    });

    ws.onError((err) => logger.error("WebSocket 错误", err));
  };

  return {
    name: "my-adapter",
    version: "1.0.0",
    async start(context) {
      stopping = false;
      await connect(context);
    },
    async stop() {
      stopping = true;
      await ws?.close(1000, "adapter stop");
      ws = undefined;
    },
  };
};
```

## 驱动器与网关

适配器内部还可以注册多个网关 Gateway。每个网关是一条独立的连接单元。两者的区别是：网关是适配器自己的概念，代表业务连接，例如每个 bot 一条连接；驱动器是框架的概念，代表底层网络客户端。多账号适配器常用网关管理多条连接，见 [AdapterGateway](/reference/api/interfaces/AdapterGateway)。

## 插件能否使用驱动器

可以。`ctx.getDriver()` 返回同一个驱动器实例。插件一般不需要它，需要网络请求时直接使用 fetch 即可。驱动器是给适配器准备的抽象，想为平台编写适配器见[开发适配器](/developer/adapter-dev)。

## 下一步

- [开发适配器](/developer/adapter-dev)：适配器的完整结构
- [运行时生命周期](/advanced/runtime)：驱动的创建与关闭时机
- [AdapterGateway 类型参考](/reference/api/interfaces/AdapterGateway)：网关的接口定义
