---
title: 插件间通信
description: 通过服务在插件之间共享能力，包含获取服务、提供服务与声明依赖。
---

# 插件间通信

插件各自是独立的包，默认互不打扰。功能变复杂后难免需要配合，例如聊天插件要调用 AI 服务，帮助插件要调用截图服务。Mioku 为此提供了服务 Service 机制。

## 服务

一个服务就是实现了 `MiokuService` 接口的对象。

| 字段 | 说明 |
| --- | --- |
| `name` | 服务名 |
| `init()` | 初始化，框架加载服务时调用 |
| `api` | 对外暴露的接口对象，其他插件拿到的就是它 |
| `dispose()` | 卸载清理，可选 |

服务的来源有两种，框架启动时会自动发现并加载。

- 本地 `services/` 目录下的文件夹，目录位置可以用配置项 `services_dir` 修改。
- `node_modules` 中所有 `mioku-service-*` 开头的 npm 包。

加载时框架调用服务的 `init()`，然后把 `api` 挂进服务注册表，键是服务的短名。例如 `mioku-service-audio` 的短名是 `audio`。

::: tip getService 返回的是 api
`getService` 返回服务的 `api` 对象，不是整个 `MiokuService`。设计服务时，需要暴露的方法都要放进 `api`。
:::

## 使用其他插件的服务

取服务有三个函数，都从 `mioku` 导入。

```typescript
import { getService, requireService, hasService, Services } from "mioku";

getService(ctx, Services.Config); // 没有则返回 undefined
requireService(ctx, Services.AI); // 没有则直接抛错
hasService(ctx, Services.Help);   // 返回 true 或 false
```

选择方式如下。服务可有可无、缺失时能降级运行的用 `getService` 并判空。缺失时无法工作的用 `requireService`，让它在启动时就报错，不要拖到运行中才失败。`hasService` 一般用于功能探测，例如检测某个可选服务是否安装。

`defineService` 用于创建类型安全的引用。它只记录 id，不做任何查询，因此可以在模块顶层定义并到处传递。

```typescript
import { defineService } from "mioku";
import type { WeatherApi } from "mioku-plugin-weather";

const Weather = defineService<WeatherApi>("weather");
```

实际用法如下，示例取自 help 插件并做了精简。先取服务，判空，再注册。

```typescript
import { definePlugin, getService, Services } from "mioku";

export default definePlugin({
  name: "demo",
  async setup(ctx) {
    const configService = getService(ctx, Services.Config);
    const helpService = getService(ctx, Services.Help);

    if (configService) {
      // 把默认配置注册进配置服务，之后可以热更新
      await configService.registerConfig("demo", "base", { enabled: true });
    }

    if (helpService) {
      helpService.registerHelp("demo", {
        title: "演示",
        description: "一个演示插件",
        commands: [{ cmd: "#demo", desc: "演示指令" }],
      });
    }
  },
});
```

第三方服务包也可以用同样的方式消费。例如 chat 插件使用 audio 服务发送语音，类型直接从服务包导入。

```typescript
import type { AudioServiceApi } from "mioku-service-audio";

const audioService = ctx.services.audio as AudioServiceApi | undefined;
if (!audioService) {
  ctx.logger.warn("audio 服务未安装，语音消息将不会发出");
}
```

`ctx.services` 是按名字索引的注册表。从这里取到的值是 `unknown` 类型，需要自行断言。

## 提供自己的服务

`ctx.addService(name, value)` 把任意对象注册进服务注册表，返回注销函数。插件卸载时框架会自动调用，不需要额外处理清理。

下面的插件 A 提供天气查询。

```typescript
import { definePlugin } from "mioku";

// 想让其他插件拿到类型，就把接口导出去
export interface WeatherApi {
  query(city: string): Promise<string>;
}

export default definePlugin({
  name: "weather",
  // 数值小的插件先加载，保证消费方运行时服务已经就位
  priority: 50,
  async setup(ctx) {
    const api: WeatherApi = {
      async query(city) {
        const res = await fetch(
          `https://wttr.in/${encodeURIComponent(city)}?format=3`,
        );
        return res.text();
      },
    };
    ctx.addService("weather", api);
    ctx.logger.info("weather 服务已注册");
  },
});
```

插件 B 使用它查询天气。

```typescript
import { definePlugin, defineService, requireService } from "mioku";
import type { WeatherApi } from "mioku-plugin-weather";

const Weather = defineService<WeatherApi>("weather");

export default definePlugin({
  name: "weather-report",
  async setup(ctx) {
    const weather = requireService(ctx, Weather);
    ctx.handle("message", async (event) => {
      const text = ctx.text(event);
      const city = text.match(/^天气\s+(.+)$/)?.[1];
      if (city) {
        await event.reply(await weather.query(city));
      }
    });
  },
});
```

::: warning 加载顺序
消费方的 `setup` 执行时，提供方必须已经注册好服务，否则 `requireService` 会直接抛错。用 `priority` 控制顺序，把提供方的数值调小，让它先加载。
:::

同名服务重复注册会覆盖旧值。不想覆盖时，`addService` 还有第三个参数 `cover`，传 `false` 表示仅在名字为空时注册。

## 内置服务

框架自带四个服务，引用都收在 `Services` 对象中。

| 引用 | 名字 | 说明 |
| --- | --- | --- |
| `Services.AI` | `ai` | 管理提供商、模型、实例和技能，见[使用 AI 服务](/developer/ai) |
| `Services.Config` | `config` | 插件配置的注册、读取与热更新 |
| `Services.Screenshot` | `screenshot` | 把 HTML、Markdown 或 URL 渲染成图片 |
| `Services.Help` | `help` | 插件帮助信息的注册与查询 |

方法签名见[类型参考](/reference/api/interfaces/ConfigService)。

## 声明服务依赖

插件依赖哪些服务，写进 `package.json` 的 `mioku.services`。

```json
{
  "mioku": {
    "services": ["ai", "config"]
  }
}
```

这样有两个好处。用户执行 `mioku install plugin` 安装插件时，CLI 会读取这个列表，把缺少的服务包一并装上。即使装漏了，启动时框架也会给出警告，指出哪个插件缺少哪个服务。列表中写的是服务短名，例如 `ai`，不是 `mioku-service-ai`。

想把自己的能力做成正式的服务包，见[开发服务](/developer/service-dev)。

## 下一步

- [使用 AI 服务](/developer/ai)：消费内置的 AI 服务
- [开发服务](/developer/service-dev)：把能力封装成独立服务包
- [配置与数据存储](/developer/config-data)：使用配置服务保存配置
