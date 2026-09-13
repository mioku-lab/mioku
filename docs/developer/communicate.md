# 插件间通信

插件各自是独立的包，平时互不打扰。但功能做深了难免要配合：聊天插件要调 AI 服务，帮助插件要拿截图服务渲染图片，你的插件可能也想把某个能力开放给别的插件用。Mioku 为此准备了一套很轻的机制——服务（Service）。

## 服务长什么样

一个服务就是实现了 `MiokuService` 接口的对象：

| 字段            | 说明                   |
|---------------|----------------------|
| `name`        | 服务名                  |
| `init()`      | 初始化，框架加载服务时调用        |
| `api`         | 对外暴露的接口对象，其他插件拿到的就是它 |
| `dispose()`   | 卸载清理（可选）             |

服务的来源有两种，框架启动时会自动发现并加载：

- 本地 `services/` 目录下的文件夹（目录位置可以用配置项 `services_dir` 改）
- `node_modules` 里所有 `mioku-service-*` 开头的 npm 包

加载时框架调用服务的 `init()`，然后把 `api` 挂进服务注册表，key 是服务的短名（`mioku-service-audio` → `audio`）。

::: tip
`getService` 返回的是服务的 `api` 对象，不是整个 `MiokuService`。所以设计服务时，把想暴露的方法都放进 `api`。
:::

## 用别人的服务

取服务有三个函数，都从 `mioku` 导入：

```typescript
import { getService, requireService, hasService, Services } from "mioku";

getService(ctx, Services.Config); // 没有就返回 undefined
requireService(ctx, Services.AI); // 没有直接抛错
hasService(ctx, Services.Help);   // 返回 true / false
```

怎么选：服务可有可无、缺了能降级运行的，用 `getService` 判空；缺了就没法干活的，用 `requireService` 让它启动时就报错，别拖到运行中才炸。`hasService` 一般用来做功能探测，比如检测某个可选服务装没装。

`defineService` 用来造一个类型安全的引用，它只记录 id，不做任何查询——所以可以在模块顶层定义，到处传：

```typescript
import { defineService } from "mioku";
import type { WeatherApi } from "mioku-plugin-weather";

const Weather = defineService<WeatherApi>("weather");
```

实际用起来是这样的（help 插件的真实用法，稍作精简）：先取服务，判空，再注册：

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

第三方服务包也能这么消费。比如 chat 插件用 audio 服务发语音，类型直接从服务包导入：

```typescript
import type { AudioServiceApi } from "mioku-service-audio";

const audioService = ctx.services.audio as AudioServiceApi | undefined;
if (!audioService) {
  ctx.logger.warn("audio 服务未安装，语音消息将不会发出");
}
```

`ctx.services` 就是那个按名字索引的注册表，点出来的是什么类型框架管不了，记得自己断言。

## 自己提供服务

`ctx.addService(name, value)` 把任意对象注册进服务注册表，返回注销函数，插件卸载时框架会自动调用，不用你操心清理。

拿插件 A 提供天气查询举例：

```typescript
import { definePlugin } from "mioku";

// 想让别的插件拿到类型，就把接口导出去
export interface WeatherApi {
  query(city: string): Promise<string>;
}

export default definePlugin({
  name: "weather",
  // 数值小的插件先加载，保证消费方跑起来时服务已经就位
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

插件 B 拿它查天气：

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

::: warning
消费方的 `setup` 执行时，提供方必须已经注册好服务，否则 `requireService` 会直接抛错。靠 `priority` 控制顺序：提供方的数值调小，先加载。
:::

同一个名字重复注册会覆盖旧值；不想覆盖的话，`addService` 还有第三个参数 `cover`，传 `false` 就只在名字空着时才注册。

## 内置服务

框架自带的四个服务，引用都收在 `Services` 对象里：

| 引用                    | 名字           | 干什么                                       |
|-----------------------|--------------|-------------------------------------------|
| `Services.AI`         | `ai`         | 管理提供商、模型、实例、技能，见[使用 AI 服务](/developer/ai) |
| `Services.Config`     | `config`     | 插件配置的注册、读取与热更新                            |
| `Services.Screenshot` | `screenshot` | 把 HTML / Markdown / URL 渲染成图片             |
| `Services.Help`       | `help`       | 插件帮助信息的注册与查询                              |

各自的方法签名见[类型参考](/reference/api/interfaces/ConfigService)。

## 在 manifest 里声明服务依赖

你的插件依赖哪些服务，写进 package.json 的 `mioku.services`：

```json
{
  "mioku": {
    "services": ["ai", "config"]
  }
}
```

好处有两个：用户用 `mioku install plugin` 装你的插件时，CLI 会读这个列表，把缺的服务包一并装上；就算装漏了，启动时框架也会打警告，告诉你哪个插件缺哪个服务。列表里写的是服务短名（`ai`，不是 `mioku-service-ai`）。

想把自己插件的能力做成正经的服务包（`mioku-service-*`），见[开发服务](/developer/service-dev)。

## 下一步

- [使用 AI 服务](/developer/ai) —— 内置 AI 服务的完整用法
- [开发服务](/developer/service-dev) —— 把能力封装成独立服务包
- [MiokuService 类型参考](/reference/api/interfaces/MiokuService)
