# 配置与数据存储

插件跑起来之后总会需要记住一些东西：用户想改的参数（问候语、目标群、开关），还有程序自己攒的数据（计数、词条、会话记录）。这两类东西 Mioku 分开存放：配置放 `config/<插件名>/`，数据放 `data/<插件名>/`。混在一起的话，以后备份和迁移都会麻烦。

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

配置的读写由配置服务（`mioku-service-config`）统一管理，所有插件共用一套：注册默认值、读取、更新、订阅变化。配置文件改动会热重载，保存 JSON 之后插件就能拿到新值，不用重启。

### 拿到配置服务

```typescript
import { getService, Services } from "mioku";

async setup(ctx) {
  const configService = getService(ctx, Services.Config);
  if (!configService) {
    // 服务没加载时拿到的是 undefined，别直接当有来用
    ctx.logger.warn("config 服务未加载，使用内置默认配置");
  }
}
```

同时在自己的 package.json 里声明依赖这个服务：

```json
{
  "mioku": {
    "services": ["config"]
  }
}
```

### 完整示例：早安问候

一个每天早上问好的插件，问候语、目标群、开关都做成配置：

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
  message: "早上好！今天也要元气满满哦～",
};

export default definePlugin({
  name: "greeting",

  async setup(ctx) {
    const configService = getService(ctx, Services.Config);
    let config = DEFAULT_CONFIG;

    if (configService) {
      // 注册配置：config/greeting/base.json 不存在就按默认值创建
      await configService.registerConfig("greeting", "base", DEFAULT_CONFIG);
      const saved = await configService.getConfig("greeting", "base");
      if (saved) config = saved as GreetingConfig;

      // 用户改文件（或代码里 updateConfig）之后，这里收到新配置
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

第一次启动后，`config/greeting/base.json` 长这样。想调整行为，直接编辑这个文件就行：

```json
{
  "enabled": true,
  "groups": ["123456789"],
  "message": "早上好！今天也要元气满满哦～"
}
```

`onConfigChange` 的返回值是取消订阅函数。插件可能被禁用或 reload 的话，把它记到清理函数里更稳妥，不然旧回调还挂在订阅列表里（core 插件就是这么收拾的）。

`registerConfig` 的合并规则值得知道：默认值只负责补缺。文件里已经有的键，无论用户改成什么（包括把数组改短）都以文件为准；把某个顶层键整个删掉，下次启动默认值会把它补回来。嵌套对象是整体替换，不做深层合并——要改嵌套结构就得整个键一起给。

### API 一览

| 方法                                                      | 说明                                                        |
|---------------------------------------------------------|-----------------------------------------------------------|
| `registerConfig(pluginName, configName, initialConfig)` | 注册配置。文件不存在则按默认值创建；`initialConfig` 给对象或 JSON 文件路径都行。返回是否成功 |
| `getConfig(pluginName, configName)`                     | 读取配置（带缓存），文件不存在返回 `null`                                  |
| `updateConfig(pluginName, configName, updates)`         | 更新配置并写入文件（与当前内容浅合并），返回是否成功                                |
| `onConfigChange(pluginName, configName, callback)`      | 订阅配置变化，返回取消订阅函数                                           |
| `getPluginConfigs(pluginName)`                          | 一次读出某插件的全部配置                                              |

::: tip updateConfig 之前先 registerConfig
`updateConfig` 改的是磁盘上的文件，配置没注册过（文件不存在）时它会直接返回 `false`。所以惯例是 setup 里先 `registerConfig`，之后再更新。
:::

### 在聊天里改配置

`updateConfig` 让插件能自己写配置，配合 `onConfigChange` 就能做「在聊天里改设置」这种功能：

```typescript
ctx.handle("message", async (event) => {
  if (!configService) return;
  if (!ctx.isOwner(event)) return;

  if (ctx.text(event).includes("关闭早安问候")) {
    await configService.updateConfig("greeting", "base", { enabled: false });
    await event.reply("好的，明天不见～");
  }
});
```

注意这里没有手动改 `config` 变量——`updateConfig` 落盘后文件监听会触发订阅回调，内部状态自己就更新了，别重复赋值。

## 数据存储：createStore / createDB

程序运行时攒出来的数据别往 config/ 里塞，那是用户的地盘，热重载也是为它设计的。插件私有数据放 `data/<插件名>/`，框架提供了 `ensureDataDir` 来拿这个目录（不存在会创建）：

```typescript
import { ensureDataDir } from "mioku";

const dir = ensureDataDir("wordbook"); // <项目>/data/wordbook/
```

存 JSON 用 `ctx.createStore` / `ctx.createDB`，两者都是 lowdb 的封装，返回的 `db` 上 `.data` 就是数据对象，改完 `await db.write()` 落盘：

| 方法 | 适用 |
| --- | --- |
| `ctx.createDB(filename, { defaultData, compress })` | 自己给完整路径，配合 `ensureDataDir` 存到 data/ 下 |
| `ctx.createStore(defaultData, { importMeta, filename })` | 文件跟代码走：按 `import.meta` 定位到调用文件所在目录，默认文件名 `data.json` |

两个小差别：`createStore` 初始化时会立刻写一次盘，文件马上出现；`createDB` 只读取，文件不存在时 `db.data` 是 defaultData，磁盘上要等你第一次 `write()` 才有文件。另外两者都有 `compress` 选项，开了之后 JSON 压成一行，省空间但也别想手工编辑了。

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
        await db.write(); // 不 write 的话改动只在内存里，重启就没了
        await event.reply(`已添加：${add[1]}`);
      }
    });
  },
});
```

`createStore` 的用法，文件会出现在调用它的源码文件旁边：

```typescript
const store = await ctx.createStore({ visits: 0 }, {
  importMeta: import.meta,
  filename: "stats.json",
});

store.data.visits += 1;
await store.write();
```

::: warning write 不及时的坑
改了 `db.data` 忘了 `await db.write()`，进程一退改动就丢了。高频写入的数据（每条消息都要记的那种）建议攒一批再写，量大的直接上 SQLite，仓库里的插件就有这么干的。
:::

## 配置还是数据？

拿不准往哪放的时候问自己一句：这个值用户会想改吗？

|       | 配置（config/）                        | 数据（data/）           |
|-------|------------------------------------|---------------------|
| 谁来写   | 用户编辑文件 / 插件 `updateConfig` / WebUI | 程序自己                |
| 谁来读   | 插件 `getConfig`（缓存 + 热重载）           | 程序直接操作 `db.data`    |
| 典型内容  | 开关、群号列表、问候语                        | 计数器、词条库、会话记录、缓存     |
| 改动生效  | 文件保存即热重载                           | 插件自己控制 `write()` 时机 |
| 换机器迁移 | 拷 `config/` 目录                     | 拷 `data/` 目录        |

问候语算配置——用户想改成自己的风格；某个词条今天被查了多少次算数据——这是程序记账，用户既不想也没法手改。灰色地带也有，比如「用户在聊天里添加的自定义回复」：两边都说得通，看你会不会把它导出分享，会的话按配置放，不会就按数据处理。

## 自定义 WebUI 配置界面

用户可以用 WebUI 改插件配置。默认 WebUI 渲染的是配置文件对应的 JSON 编辑器，能用但不够友好。想给用户一个像样的配置界面，在插件包根目录放一个 `config.md`——WebUI 读到它，就会按里面的定义渲染自定义表单，替代 JSON 编辑器。

`config.md` 分两部分：**YAML frontmatter** 声明字段，**Markdown 正文**里用 `mioku-field` 代码块占位，WebUI 在占位处渲染对应的表单控件。

一个完整的例子：

```markdown
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
    placeholder: 早上好！

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


### frontmatter 字段

`fields` 是字段定义数组，每一项：

| 字段             | 必填 | 说明                                                                                                      |
|----------------|----|---------------------------------------------------------------------------------------------------------|
| `key`          | ✅  | 字段路径，格式 `<配置名>.<路径>`。`base.enabled` 对应 `config/<插件名>/base.json` 里的 `enabled`；嵌套用点连，如 `base.notify.time` |
| `label`        | ✅  | 表单上的显示名称                                                                                                |
| `type`         | ✅  | 控件类型，见下表                                                                                                |
| `description`  |    | 字段说明，显示在表单里                                                                                             |
| `placeholder`  |    | 输入框占位文字                                                                                                 |
| `required`     |    | 是否必填                                                                                                    |
| `defaultValue` |    | 默认值                                                                                                     |
| `options`      |    | `select` / `multi-select` 类型的选项列表，每项 `{ value, label }`                                                 |
| `itemFields`   |    | `array` 类型用：数组里每项的字段定义（key 写相对路径，如 `group`）                                                             |

`type` 支持九种：`text`（单行文本）、`textarea`（多行）、`number`、`switch`（开关）、`select`（单选下拉）、`multi-select`（多选）、`secret`（密码框）、`json`（JSON 编辑）、`array`（数组，配 `itemFields`）。

### 位置与生效

- **本地插件**：`plugins/<插件名>/config.md`
- **npm 插件**：包根目录 `config.md`
- **本地服务**：`services/<服务名>/config.md`；**npm 服务**：包根目录 `config.md`
- **适配器**：包根目录 `config.md`（适配器没有本地目录形态，只走 npm 包）

config.md 是声明性的，写错不会炸：缺 `key` / `label` / `type` 的字段会被跳过并打警告；`key` 不带点（没有配置名部分）也会被警告。加载失败时 WebUI 退回默认的 JSON 编辑器，不影响使用。

### 服务的 config.md

服务和插件写法一样，只是文件放在服务包里、配置落在 `config/service/<服务名>/` 下。真实例子（`mioku-service-60s`）：

```markdown
---
title: 60s 服务配置
description: 配置 60s API 服务的连接参数
fields:
  - key: base.baseUrl
    label: 60s API 地址
    type: text
    description: 60s 服务地址。默认使用官方公开实例，也可以改成你自己部署的 60s API 服务地址。
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

这里 `key` 的第一段 `base` 是**配置文件名**（`config/service/60s/base.json`），和插件完全一致。

### 适配器的 config.md

适配器特殊一点：它的配置不在 `config/` 目录，而在 `package.json` 的 `mioku.adapters.<适配器名>` 下，所以 `key` 的第一段是**适配器名**。真实例子（`mioku-adapter-onebotv11`）：

```markdown
---
title: onebotv11 适配器配置
description: 配置 OneBot v11 (NapCat) 适配器的连接实例
fields:
  - key: onebotv11.instances
    label: 连接实例
    type: array
    description: 每个实例对应一个 NapCat 连接。可添加多个实例，机器人会同时连接。
    itemFields:
      - key: protocol
        label: 连接协议
        type: select
        options:
          - value: ws
            label: ws (未加密)
          - value: wss
            label: wss (加密)

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

注意 `itemFields` 里的 `key` 是相对路径（`protocol`、`host`），不带适配器名。这类数组字段在 WebUI 里渲染成可增删的列表，每项按 `itemFields` 生成表单。

## 参考

- [配置文件](/guide/configuration) —— config/ 和 data/ 目录的完整约定
- [插件间通信](/developer/communicate) —— 配置服务之外的其他服务怎么用
- [定时任务与生命周期](/developer/cron-lifecycle) —— 上面示例里 cron 的细节
- [类型参考 - ConfigService](/reference/api/interfaces/ConfigService)
