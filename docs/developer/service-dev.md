# 开发服务

插件写多了你会发现一件事：好些能力谁都要用——读配置、渲染图片、调模型。每个插件自己实现一遍，既重复又容易写得参差不齐。服务就是给这类东西准备的：把能力打包成一个对象挂到框架上，谁要用谁来取。`ai`、`config`、`screenshot`、`help` 这几个系统服务你天天在用，只是没意识到它们也是"别人写好的服务"。

这一章我们写一个"随机一言"服务，再写个插件消费它，最后发布成 npm 包。

## 服务和插件差在哪

一句话：插件做功能，服务做接口。

| | 插件 | 服务 |
| --- | --- | --- |
| 干什么 | 监听事件、跑业务逻辑 | 提供可复用的能力 |
| 怎么被用 | 框架派事件给它 | 插件主动来取 |
| 有没有事件 | 有，`ctx.handle` 注册监听 | 没有，就是个接口对象 |
| 生命周期 | `setup` / 清理函数 | `init()` / `dispose()` |

系统服务的分工：

| 服务 | 干什么 |
| --- | --- |
| `ai` | 调模型、管理提供商和技能，chat 插件的底座 |
| `config` | 插件配置的注册、读取、热重载 |
| `screenshot` | 把 HTML / Markdown / URL 渲染成图片 |
| `help` | 收集各插件的帮助信息，给 help 指令用 |

## MiokuService 长什么样

每个服务都是一个 [MiokuService](/reference/api/interfaces/MiokuService) 对象：

| 字段 | 说明 |
| --- | --- |
| `name` | 服务名，加载后插件按这个名字取服务 |
| `init()` | 初始化，框架加载服务时调用 |
| `api` | 对外暴露的接口对象 |
| `dispose()` | 卸载时的清理逻辑，可选 |

版本号、描述走 `package.json`，由 `ServiceMetadata` 统一读出，不要在服务对象里再写一份。

关键就一条：**`init()` 里把 `api` 填上**。框架调完 `init`，会把 `service.api` 挂进服务注册表，插件通过 `getService` 拿到的就是这个 `api`。所以 `api` 里放什么，插件就能用什么——它是这个服务的全部门面。

## 示例服务：随机一言

在你的项目根目录建一个 `services/sentence/`，放两个文件：

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

`package.json` 先占个位，内容后面讲：

```json
{
  "name": "sentence",
  "version": "1.0.0",
  "description": "随机一言服务",
  "main": "index.ts",
  "type": "module"
}
```

然后是本体 `index.ts`：

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
    // 注册配置文件，不存在就把默认值落盘
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

重启框架，日志里会看到 `发现了 N 个服务`，以及服务自己打的那行 `sentence 服务已就绪`。到这里服务就挂上了，虽然还没人用它。

这段代码里几个点：

- **`api` 的类型**在文件顶部单独声明并导出（`SentenceAPI`）。谁消费谁 import 这个类型，拿到的对象全程有提示。
- **`init()` 里干了三件事**：读配置、准备好词库、把 `getOne` 填进 `this.api`。有异步初始化（连数据库、拉远端词库）都写在这里，框架会等它完成。
- **`dispose()`** 在框架关闭时按加载的相反顺序调用，释放资源写这里，不释放就不写。

## 写个插件消费它

服务加载在插件之前，所以插件 `setup` 里可以放心取：

```text
plugins/
└── yiyan/
    └── index.ts
```

```typescript
import { definePlugin, defineService, getService } from "mioku";
import type { SentenceAPI } from "../../services/sentence";

// 声明一个服务引用：泛型是服务的接口，id 是服务名
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

终端里输入「一言」就能收到随机一言了。

`defineService<T>(id)` 只是造了一个带类型的引用（`{ id }`），不做任何查询，可以放模块顶层。真正取服务的是 `getService(ctx, ref)`，配套还有两个：

| 函数 | 行为 |
| --- | --- |
| `getService(ctx, ref)` | 取服务，没加载返回 `undefined` |
| `requireService(ctx, ref)` | 取服务，没加载直接抛错 |
| `hasService(ctx, ref)` | 判断服务是否已加载 |

不想声明引用，直接 `ctx.services["sentence"]` 也能拿到——只是类型是 `unknown`，得自己断言。内置服务有现成的引用集合 `Services`，不用自己 define：

```typescript
import { Services, getService } from "mioku";

const config = getService(ctx, Services.Config);
const ai = getService(ctx, Services.AI);
```

::: tip 让框架知道你依赖谁
在插件 `package.json` 的 `mioku` 字段里声明服务依赖，框架启动时会检查缺失并打警告，脚手架装包时也会用到：

```json
{
  "mioku": {
    "services": ["sentence"]
  }
}
```
:::

## 服务的两种形态

和插件一样，服务有两种放法：

- **本地服务**：放在项目 `services/` 目录（想换位置用 `package.json` 里 `mioku.services_dir` 配），文件夹名就是服务名，改完重启生效，开发调试用这个
- **npm 服务**：发布成 `mioku-service-*` 包，`bun add` 安装，服务名是包名去掉前缀的短名

框架启动时先扫 `services/` 目录，再扫 `node_modules` 里的 `mioku-service-*` 包，两边都进同一张表——同名时 npm 包会盖掉本地版本。

对目录里每个候选，加载器按这个流程走：

```text
有 package.json 吗 → 没有，跳过（日志里都不会出现）
找入口 index.ts → index.js → 都没有，报"入口丢失"
import 入口，检查 init 是不是函数 → 不是，报"无效：缺少 init()"
调 init() → 成功后把 api 挂进注册表
```

注意两点：本地服务也需要 `package.json`，不少人在这里栽跟头；入口文件名固定认 `index.ts` / `index.js`，叫别的名字不会被加载。

## 服务配置

服务的配置统一放在 `config/service/<服务名>/` 下，框架提供了四个函数（都从 `mioku` 导入）：

| 函数 | 干什么 |
| --- | --- |
| `registerServiceConfig(名, 配置名, 默认值)` | 文件不存在时把默认值写盘，存在则不动 |
| `getServiceConfig(名, 配置名)` | 读配置，文件不存在或坏了返回 `{}` |
| `updateServiceConfig(名, 配置名, 值)` | 覆盖写入 |
| `getServiceConfigs(名)` | 读这个服务的全部配置文件 |

上面的 sentence 服务里已经用了一对：`init` 时 `registerServiceConfig` 落盘默认词库，用户想换词直接改文件，重启生效。

```text
config/
└── service/
    └── sentence/
        └── words.json
```

除了配置，服务还可以用 `getServiceDataDir("sentence")` 拿到自己的数据目录 `data/sentence/`，缓存、数据库文件往里放。

## 发布成 npm 包

服务写好了，把 `package.json` 补成正式样子：

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

几个字段有讲究：

- **`name`** 必须 `mioku-service-*`，框架按这个前缀扫描，短名（`sentence`）就是服务名
- **`keywords`** 带上 `mioku`，别人在市场里搜得到你
- **入口**：加载器只认包根目录的 `index.ts` 或 `index.js`，不看别的字段——别把入口挪到 `src/main.ts` 就以为万事大吉。官方服务包（如 `mioku-service-config`）就是这么直接指到 `index.ts` 的
- **`mioku` 放 `peerDependencies`**：类型从框架来，别把它打进自己的依赖里

用户侧安装就是一条命令：

```text
bun add mioku-service-sentence
```

装完重启，服务管理器扫到它就自动加载，插件里 `defineService<SentenceAPI>("sentence")` 照常取用。

## 下一步

- [插件与服务通信](/developer/communicate) —— 服务和插件之间怎么配合干活
- [MiokuService 类型参考](/reference/api/interfaces/MiokuService) —— 服务接口的完整定义
- [操作 Bot](/developer/bot) —— 服务里拿到 bot 之后能干什么
