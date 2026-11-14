---
title: 开发服务
description: 创建 Mioku 服务，向插件暴露可复用的 api，并发布成 npm 包。
---

# 开发服务

插件数量变多后，会出现一批谁都要用的能力，例如读取配置、渲染图片和调用模型。每个插件各实现一遍既重复又难以保持一致。服务 Service 就是为这类能力准备的。把能力打包成一个对象挂到框架上，需要时按服务名取用。`ai`、`config`、`screenshot` 和 `help` 是框架自带的四个服务。

本章编写一个随机一言服务，再编写一个插件消费它，最后发布成 npm 包。

## 服务与插件的区别

|  | 插件 | 服务 |
| --- | --- | --- |
| 做什么 | 监听事件、执行业务逻辑 | 提供可复用的能力 |
| 如何被使用 | 框架派发事件给它 | 插件主动取用 |
| 是否有事件 | 有，通过 `ctx.handle` 注册监听 | 没有，只是一个接口对象 |
| 生命周期 | `setup` 与清理函数 | `init()` 与 `dispose()` |

四个系统服务的分工如下。

| 服务 | 做什么 |
| --- | --- |
| `ai` | 调用模型、管理提供商和技能，chat 插件的底座 |
| `config` | 插件配置的注册、读取与热重载 |
| `screenshot` | 把 HTML、Markdown 或 URL 渲染成图片 |
| `help` | 收集各个插件的帮助信息，供 help 指令使用 |

## MiokuService

每个服务都是一个 [MiokuService](/reference/api/interfaces/MiokuService) 对象。

| 字段 | 说明 |
| --- | --- |
| `name` | 服务名，加载后插件按这个名字取服务 |
| `init()` | 初始化，框架加载服务时调用 |
| `api` | 对外暴露的接口对象 |
| `dispose()` | 卸载时的清理逻辑，可选 |

版本号和描述写在 `package.json` 中，由 `ServiceMetadata` 统一读取，不需要在服务对象中重复声明。

关键只有一条：在 `init()` 中把 `api` 填上。框架调用完 `init` 后会把 `service.api` 挂进服务注册表，插件通过 `getService` 拿到的就是这个 `api`。`api` 中有什么，插件就能用什么，它是这个服务的全部对外接口。

## 示例服务

在项目根目录新建 `services/sentence/`，放入两个文件。

```text
my-bot/
├── package.json
├── app.ts
├── services/
│   └── sentence/
│       ├── package.json
│       └── index.ts
└── plugins/
```

`package.json` 先占位，后面会补充完整。

```json
{
  "name": "sentence",
  "version": "1.0.0",
  "description": "随机一言服务",
  "main": "index.ts",
  "type": "module"
}
```

服务本体 `index.ts`：

```typescript
import { logger, registerServiceConfig, getServiceConfig } from "mioku";
import type { MiokuService } from "mioku";

/** sentence 服务暴露给插件的接口 */
export interface SentenceAPI {
  /** 随机取一条一言 */
  getOne(): Promise<string>;
}

const DEFAULT_WORDS = [
  "人生若只如初见",
  "今晚月色真美",
  "路漫漫其修远兮",
];

const sentenceService: MiokuService = {
  name: "sentence",
  api: {} as SentenceAPI,

  async init() {
    // 注册配置文件，不存在时把默认值落盘
    await registerServiceConfig("sentence", "words", { words: DEFAULT_WORDS });
    const config = await getServiceConfig("sentence", "words");
    const words = Array.isArray(config.words) ? config.words : DEFAULT_WORDS;

    this.api = {
      getOne: async () => words[Math.floor(Math.random() * words.length)],
    };

    logger.info("sentence 服务已就绪");
  },

  async dispose() {
    logger.info("sentence 服务已卸载");
  },
};

export default sentenceService;
```

重启框架后，日志中会出现 `发现了 N 个服务` 以及服务自己打印的 `sentence 服务已就绪`。服务已经挂上，只是还没有人使用。

这段代码有三个要点。

- **`api` 的类型**在文件顶部单独声明并导出，即 `SentenceAPI`。消费方导入这个类型后，拿到的对象全程有类型提示。
- **`init()` 中做了三件事**：读取配置、准备词库、把 `getOne` 填进 `this.api`。异步初始化，例如连接数据库或拉取远端词库，都写在这里，框架会等待它完成。
- **`dispose()`** 在框架关闭时按加载的相反顺序调用。需要释放资源时写在这里，没有资源需要释放可以不写。

## 消费服务

服务在插件之前加载，因此插件可以在 `setup` 中直接取用。

```text
plugins/
└── yiyan/
    └── index.ts
```

```typescript
import { definePlugin, defineService, getService } from "mioku";
import type { SentenceAPI } from "../../services/sentence";

// 声明一个服务引用，泛型是服务的接口，id 是服务名
const sentence = defineService<SentenceAPI>("sentence");

export default definePlugin({
  name: "yiyan",
  async setup(ctx) {
    const api = getService(ctx, sentence);
    if (!api) {
      ctx.logger.warn("sentence 服务没加载，本插件不工作");
      return;
    }

    ctx.handle("message", async (event) => {
      if (ctx.text(event).trim() === "一言") {
        await event.reply(await api.getOne());
      }
    });
  },
});
```

在终端输入 `一言` 就能收到随机一言。

`defineService<T>(id)` 只是创建一个带类型的引用，形式是 `{ id }`，不做任何查询，因此可以放在模块顶层。真正取服务的是 `getService(ctx, ref)`，配套还有两个。

| 函数 | 行为 |
| --- | --- |
| `getService(ctx, ref)` | 取服务，未加载时返回 `undefined` |
| `requireService(ctx, ref)` | 取服务，未加载时直接抛错 |
| `hasService(ctx, ref)` | 判断服务是否已加载 |

不声明引用时，直接读取 `ctx.services["sentence"]` 也可以拿到服务，只是类型是 `unknown`，需要自行断言。内置服务提供了现成的引用集合 `Services`，不需要自己定义。

```typescript
import { Services, getService } from "mioku";

const config = getService(ctx, Services.Config);
const ai = getService(ctx, Services.AI);
```

::: tip 声明服务依赖
在插件 `package.json` 的 `mioku` 字段中声明服务依赖，框架启动时会检查缺失并给出警告，脚手架安装依赖时也会用到。

```json
{
  "mioku": {
    "services": ["sentence"]
  }
}
```
:::

## 服务的两种形态

与插件相同，服务有两种存放方式。

- **本地服务**：放在项目 `services/` 目录，目录位置可以用 `package.json` 中的 `mioku.services_dir` 修改。文件夹名就是服务名，修改后重启生效，适合开发调试。
- **npm 服务**：发布成 `mioku-service-*` 包，用 `bun add` 安装。服务名是包名去掉前缀的短名。

框架启动时先扫描 `services/` 目录，再扫描 `node_modules` 中的 `mioku-service-*` 包，两者进入同一张表。同名时 npm 包会覆盖本地版本。

加载器对目录中的每个候选按以下流程处理。

```text
有 package.json 吗 → 没有则跳过，日志中不会出现
查找入口 index.ts → index.js → 都没有则报「入口丢失」
import 入口，检查 init 是否为函数 → 不是则报「无效：缺少 init()」
调用 init() → 成功后把 api 挂进注册表
```

需要注意两点。本地服务同样需要 `package.json`。入口文件名固定识别 `index.ts` 和 `index.js`，其他名字不会被加载。

## 服务配置

服务配置放在 `config/service/<服务名>/` 下。框架提供四个函数，都从 `mioku` 导入。

| 函数 | 作用 |
| --- | --- |
| `registerServiceConfig(名, 配置名, 默认值)` | 文件不存在时把默认值写盘，存在时不做修改 |
| `getServiceConfig(名, 配置名)` | 读取配置，文件不存在或损坏时返回 `{}` |
| `updateServiceConfig(名, 配置名, 值)` | 覆盖写入 |
| `getServiceConfigs(名)` | 读取该服务的全部配置文件 |

前面的 sentence 服务已经用了一对。`init` 时通过 `registerServiceConfig` 落盘默认词库，用户想换词时直接修改文件，重启后生效。

```text
config/
└── service/
    └── sentence/
        └── words.json
```

除配置之外，服务还可以用 `getServiceDataDir("sentence")` 获取自己的数据目录 `data/sentence/`，用于存放缓存和数据库文件。

## 发布成 npm 包

服务完成后，把 `package.json` 补充完整。

```json
{
  "name": "mioku-service-sentence",
  "version": "1.0.0",
  "description": "随机一言服务",
  "type": "module",
  "main": "index.ts",
  "keywords": ["mioku"],
  "files": ["index.ts"],
  "peerDependencies": {
    "mioku": "^1.0.0"
  }
}
```

几个字段需要留意。

- **`name`** 必须是 `mioku-service-*`，框架按这个前缀扫描，短名 `sentence` 就是服务名。
- **`keywords`** 需要带上 `mioku`，别人在市场里才能搜到你。
- **入口**：加载器只认包根目录的 `index.ts` 或 `index.js`，不看其他字段。不要把入口挪到 `src/main.ts`。官方服务包，例如 `mioku-service-config`，就是直接指向 `index.ts` 的。
- **`mioku` 放在 `peerDependencies`**：类型来自框架，不要把它打进自己的依赖。

用户侧的安装只有一条命令。

```text
bun add mioku-service-sentence
```

安装后重启，服务管理器扫描到它会自动加载，插件中 `defineService<SentenceAPI>("sentence")` 照常可以使用。

## 下一步

- [插件间通信](/developer/communicate)：服务和插件如何配合
- [配置与数据存储](/developer/config-data)：插件侧的配置读写
- [MiokuService 类型参考](/reference/api/interfaces/MiokuService)：服务接口的完整定义
