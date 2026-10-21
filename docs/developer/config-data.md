---
title: 配置与数据存储
description: 使用配置服务与 createStore、createDB 保存插件配置和运行时数据。
---

# 配置与数据存储

插件运行过程中需要保存两类内容。一类是用户可修改的参数，例如问候语、目标群和开关。另一类是程序自己产生的数据，例如计数器、词条和会话记录。Mioku 把它们分开存放：配置放在 `config/<插件名>/`，数据放在 `data/<插件名>/`。

```text
my-bot/
├── package.json
├── config/
│   ├── greeting/
│   │   └── base.json          # greeting 插件的配置
│   └── core/
│       └── access-control.json
└── data/
    └── wordbook/
        └── words.json         # wordbook 插件的私有数据
```

## 配置服务

配置的读写由配置服务 `mioku-service-config` 统一管理，所有插件共用一套。配置服务提供注册默认值、读取、更新和订阅变化四种能力。配置文件修改后会热重载，保存 JSON 之后插件就能拿到新值，不需要重启。

### 获取配置服务

```typescript
import { getService, Services } from "mioku";

async setup(ctx) {
  const configService = getService(ctx, Services.Config);
  if (!configService) {
    // 服务未加载时返回 undefined，需要判空
    ctx.logger.warn("config 服务未加载，使用内置默认配置");
  }
}
```

同时在自己的 `package.json` 中声明依赖。

```json
{
  "mioku": {
    "services": ["config"]
  }
}
```

### 完整示例

下面是一个每天早上问好的插件，问候语、目标群和开关都做成配置。

```typescript
import { definePlugin, getService, Services } from "mioku";

interface GreetingConfig {
  enabled: boolean;
  groups: string[];
  message: string;
}

const DEFAULT_CONFIG: GreetingConfig = {
  enabled: true,
  groups: ["123456789"],
  message: "早上好",
};

export default definePlugin({
  name: "greeting",

  async setup(ctx) {
    const configService = getService(ctx, Services.Config);
    let config = DEFAULT_CONFIG;

    if (configService) {
      // 注册配置，config/greeting/base.json 不存在时按默认值创建
      await configService.registerConfig("greeting", "base", DEFAULT_CONFIG);
      const saved = await configService.getConfig("greeting", "base");
      if (saved) config = saved as GreetingConfig;

      // 用户修改文件或调用 updateConfig 后，这里会收到新配置
      configService.onConfigChange("greeting", "base", (next) => {
        config = next as GreetingConfig;
        ctx.logger.info("greeting 配置已热更新");
      });
    } else {
      ctx.logger.warn("config 服务未加载，greeting 使用内置默认配置");
    }

    ctx.cron("0 9 * * *", async (ctx) => {
      if (!config.enabled) return;
      await ctx.noticeGroups(config.groups, config.message);
    });
  },
});
```

第一次启动后，`config/greeting/base.json` 的内容如下。调整行为时直接编辑这个文件即可。

```json
{
  "enabled": true,
  "groups": ["123456789"],
  "message": "早上好"
}
```

`onConfigChange` 的返回值是取消订阅函数。插件可能被禁用或重载时，应把它记录到清理函数中，否则旧回调会留在订阅列表里。

`registerConfig` 的合并规则需要留意。默认值只负责补缺，文件中已经存在的键以文件为准，即使用户把数组改短也是文件生效。把某个顶层键整个删掉后，下次启动默认值会把它补回来。嵌套对象是整体替换，不做深层合并，修改嵌套结构时需要整个键一起提供。

### API 一览

| 方法 | 说明 |
| --- | --- |
| `registerConfig(pluginName, configName, initialConfig)` | 注册配置，文件不存在时按默认值创建。`initialConfig` 可以是对象或 JSON 文件路径。返回是否成功 |
| `getConfig(pluginName, configName)` | 读取配置，带缓存。文件不存在时返回 `null` |
| `updateConfig(pluginName, configName, updates)` | 更新配置并写入文件，与当前内容浅合并。返回是否成功 |
| `onConfigChange(pluginName, configName, callback)` | 订阅配置变化，返回取消订阅函数 |
| `getPluginConfigs(pluginName)` | 一次读出某个插件的全部配置 |

::: tip updateConfig 之前先 registerConfig
`updateConfig` 修改的是磁盘上的文件。配置没有注册过时文件不存在，它会直接返回 `false`。惯例是在 `setup` 中先调用 `registerConfig`，之后再更新。
:::

### 在聊天中修改配置

`updateConfig` 让插件可以自己写入配置，配合 `onConfigChange` 就能实现聊天中修改设置这类功能。

```typescript
ctx.handle("message", async (event) => {
  if (!configService) return;
  if (!ctx.isOwner(event)) return;

  if (ctx.text(event).includes("关闭早安问候")) {
    await configService.updateConfig("greeting", "base", { enabled: false });
    await event.reply("已关闭早安问候");
  }
});
```

这里没有手动修改 `config` 变量。`updateConfig` 落盘后会触发文件监听和订阅回调，内部状态会自动更新，不需要重复赋值。

## 数据存储

程序运行时产生的数据不要写入 `config/`，那是用户的配置目录，热重载也是为配置设计的。插件私有数据放在 `data/<插件名>/` 下，用 `ensureDataDir` 获取该目录，不存在时会自动创建。

```typescript
import { ensureDataDir } from "mioku";

const dir = ensureDataDir("wordbook"); // <项目>/data/wordbook/
```

存储 JSON 使用 `ctx.createStore` 和 `ctx.createDB`，两者都是 lowdb 的封装。返回的 `db` 上的 `.data` 就是数据对象，修改后需要 `await db.write()` 才会落盘。

| 方法 | 适用场景 |
| --- | --- |
| `ctx.createDB(filename, { defaultData, compress })` | 自行提供完整路径，配合 `ensureDataDir` 存到 `data/` 下 |
| `ctx.createStore(defaultData, { importMeta, filename })` | 文件跟随代码，按 `import.meta` 定位到调用文件所在目录，默认文件名 `data.json` |

两者的区别有两点。`createStore` 初始化时会立即写入一次磁盘，文件马上出现。`createDB` 只读取，文件不存在时 `db.data` 是 `defaultData`，磁盘上要等第一次 `write()` 才有文件。两者都有 `compress` 选项，开启后 JSON 会压缩成一行，节省空间，代价是无法手工编辑。

### 示例：词条库

```typescript
import { definePlugin, ensureDataDir } from "mioku";
import * as path from "path";

interface WordBook {
  words: Record<string, string>;
}

export default definePlugin({
  name: "wordbook",

  async setup(ctx) {
    const dir = ensureDataDir("wordbook");
    const db = await ctx.createDB<WordBook>(path.join(dir, "words.json"), {
      defaultData: { words: {} },
    });

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();

      const query = text.match(/^查询\s*(\S+)$/);
      if (query) {
        const meaning = db.data.words[query[1]];
        await event.reply(meaning ?? `没有「${query[1]}」这个词`);
        return;
      }

      const add = text.match(/^添加词条\s*(\S+)\s*([\s\S]+)$/);
      if (add) {
        db.data.words[add[1]] = add[2];
        await db.write(); // 不写入的话改动只在内存中，重启就会丢失
        await event.reply(`已添加：${add[1]}`);
      }
    });
  },
});
```

`createStore` 的用法如下，文件会出现在调用它的源码文件旁边。

```typescript
const store = await ctx.createStore({ visits: 0 }, {
  importMeta: import.meta,
  filename: "stats.json",
});

store.data.visits += 1;
await store.write();
```

::: warning 及时写入
修改 `db.data` 后忘记 `await db.write()`，进程退出时改动就会丢失。高频写入的数据可以攒一批再写，数据量较大时建议直接使用 SQLite。
:::

## 配置与数据的选择

判断标准是：这个值需要用户修改吗。

|  | 配置 `config/` | 数据 `data/` |
| --- | --- | --- |
| 谁来写 | 用户编辑文件、插件调用 `updateConfig`、WebUI | 程序自己 |
| 谁来读 | 插件通过 `getConfig` 读取，带缓存与热重载 | 程序直接操作 `db.data` |
| 典型内容 | 开关、群号列表、问候语 | 计数器、词条库、会话记录、缓存 |
| 改动生效 | 文件保存后热重载 | 由插件控制 `write()` 时机 |
| 换机器迁移 | 拷贝 `config/` 目录 | 拷贝 `data/` 目录 |

举例说明：问候语属于配置，因为用户想改成自己的风格。某个词条今天被查询了多少次属于数据，因为这是程序记账，用户无法也没有必要手工修改。灰色地带同样存在，例如用户在聊天中添加的自定义回复。判断方式是看它是否需要被导出或分享，需要则按配置处理，不需要则按数据处理。

## 自定义 WebUI 配置界面

用户可以通过 WebUI 修改插件配置。默认情况下 WebUI 渲染的是配置文件的 JSON 编辑器，可用但不够友好。想让用户看到更合适的配置界面，在插件包根目录放一个 `config.md`。WebUI 读取该文件后，会按其中的定义渲染自定义表单，替代 JSON 编辑器。

`config.md` 分两部分。YAML frontmatter 声明字段。Markdown 正文中使用 `mioku-field` 代码块占位，WebUI 在占位处渲染对应的表单控件。

一个完整的例子如下。

````markdown
---
title: 早安问候
description: 配置每日问候语与推送目标
fields:
  - key: base.enabled
    label: 启用
    type: switch
    description: 是否开启每日问候
    defaultValue: true

  - key: base.message
    label: 问候语
    type: text
    description: 每天早上发送的问候内容
    placeholder: 早上好

  - key: base.groups
    label: 目标群
    type: array
    description: 发送问候的群号列表，每项一个群号
    itemFields:
      - key: group
        label: 群号
        type: number
---

# 早安问候

在这里配置你的问候语：

```mioku-field
key: base
```
````

### frontmatter 字段

`fields` 是字段定义数组，每一项包含以下字段。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 字段路径，格式为 `<配置名>.<路径>`。`base.enabled` 对应 `config/<插件名>/base.json` 中的 `enabled`，嵌套用点连接，例如 `base.notify.time` |
| `label` | 是 | 表单上的显示名称 |
| `type` | 是 | 控件类型，取值见下 |
| `description` | 否 | 字段说明，显示在表单中 |
| `placeholder` | 否 | 输入框占位文字 |
| `required` | 否 | 是否必填 |
| `defaultValue` | 否 | 默认值 |
| `options` | 否 | `select` 与 `multi-select` 的选项列表，每项包含 `value` 和 `label` |
| `itemFields` | 否 | `array` 类型使用，定义数组中每一项的字段，`key` 写相对路径，例如 `group` |

`type` 支持九种取值。

| 取值 | 控件 |
| --- | --- |
| `text` | 单行文本 |
| `textarea` | 多行文本 |
| `number` | 数字 |
| `switch` | 开关 |
| `select` | 单选下拉 |
| `multi-select` | 多选 |
| `secret` | 密码框 |
| `json` | JSON 编辑器 |
| `array` | 数组，配合 `itemFields` 使用 |

### 位置与生效

- **本地插件**：`plugins/<插件名>/config.md`
- **npm 插件**：包根目录 `config.md`
- **本地服务**：`services/<服务名>/config.md`
- **npm 服务**：包根目录 `config.md`
- **适配器**：包根目录 `config.md`，适配器没有本地目录形态，只走 npm 包

`config.md` 是声明式的，写错不会导致崩溃。缺少 `key`、`label` 或 `type` 的字段会被跳过并记录警告。`key` 不带点，也就是缺少配置名部分时也会警告。加载失败时 WebUI 会退回默认的 JSON 编辑器，不影响使用。

### 服务的 config.md

服务和插件的写法相同，区别是文件放在服务包中，配置落在 `config/service/<服务名>/` 下。以下是 `mioku-service-60s` 的真实示例。

````markdown
---
title: 60s 服务配置
description: 配置 60s API 服务的连接参数
fields:
  - key: base.baseUrl
    label: 60s API 地址
    type: text
    description: 60s 服务地址。默认使用官方公开实例，也可以改成自行部署的 60s API 服务地址。
    placeholder: https://60s.viki.moe

  - key: base.timeoutMs
    label: 请求超时毫秒
    type: number
    description: 请求 60s API 时的超时时间。
    placeholder: 15000
---

# 60s 服务配置

```mioku-field
key: base.baseUrl
```

```mioku-field
key: base.timeoutMs
```
````

其中 `key` 的第一段 `base` 是配置文件名，对应 `config/service/60s/base.json`，与插件完全一致。

### 适配器的 config.md

适配器略有不同。它的配置不在 `config/` 目录，而在 `package.json` 的 `mioku.adapters.<适配器名>` 下，因此 `key` 的第一段是适配器名。以下是 `mioku-adapter-onebotv11` 的真实示例。

````markdown
---
title: onebotv11 适配器配置
description: 配置 OneBot v11 与 NapCat 适配器的连接实例
fields:
  - key: onebotv11.instances
    label: 连接实例
    type: array
    description: 每个实例对应一个 NapCat 连接。可以添加多个实例，机器人会同时连接。
    itemFields:
      - key: protocol
        label: 连接协议
        type: select
        options:
          - value: ws
            label: ws 未加密
          - value: wss
            label: wss 加密

      - key: host
        label: 主机地址
        type: text
        placeholder: localhost

      - key: port
        label: 端口
        type: number
        placeholder: 3001

      - key: token
        label: 访问令牌
        type: secret
---

# onebotv11 适配器配置

通过 [NapCat](https://napcat.napneko.icu/) 连接 OneBot v11 协议。

```mioku-field
key: onebotv11.instances
```
````

`itemFields` 中的 `key` 是相对路径，例如 `protocol` 和 `host`，不带适配器名。这类数组字段在 WebUI 中渲染成可增删的列表，每一项按 `itemFields` 生成表单。

## 下一步

- [配置文件](/guide/configuration)：`config/` 和 `data/` 的完整约定
- [插件间通信](/developer/communicate)：使用配置服务之外的其他服务
- [定时任务与生命周期](/developer/cron-lifecycle)：定时任务中读取配置
