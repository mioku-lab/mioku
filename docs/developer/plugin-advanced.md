# 插件进阶

## 使用调试日志

```typescript
ctx.logger.debug('调试信息')  // 仅 debug 级别可见
ctx.logger.info('普通信息')
ctx.logger.warn('警告信息')
ctx.logger.error('错误信息')
```

## 多实例支持

Mioku 支持同时连接多个 NapCat 服务端，只需在 `mioku.json` 中的 `napcat` 字段中扩充即可

运行时相关成员有：

- `ctx.bot`：当前上下文里的 bot
- `ctx.bots`：所有已连接 bot
- `ctx.self_id`：当前 bot QQ 号
- `ctx.pickBot(id)`：按 QQ 号选择 bot

```typescript
// 获取所有 bot 信息
ctx.bots.forEach((bot) => {
    ctx.logger.info(`Bot: ${bot.nickname} (${bot.bot_id})`)
    ctx.logger.info(`App: ${bot.app_name} v${bot.app_version}`)
    if (bot.name) {
        ctx.logger.info(`Name: ${bot.name}`)
    }
})

// 遍历所有群
for (const bot of ctx.bots) {
    const groups = await bot.getGroupList()
    ctx.logger.info(`${bot.name || bot.nickname}: ${groups.length} 个群`)
}
```

> [!CAUTION]
> 不当使用 `ctx.bot` 可能导致潜在的问题

`mioki` 包中，`ctx.bot` 默认取的是**第一个**连接到 Mioku 的 NapCat 服务器，而不是当前触发事件的机器人 ~~我也觉得很不合理~~

在 Mioku 连接到多个实例时，使用该方法可能导致获取到**错误的** NapCat 实例，从而导致发送消息失败

解决方法是，使用 `ctx.pickBot` 函数，通过传入 `ctx.self_id` 来获取触发本次事件的机器人。

```typescript
ctx.handle('notice.group.increase', async (e) => {
    // 若默认实例不在群内会导致消息发送失败
    await ctx.bot.sendGroupMsg(e.group_id, "欢迎加入群聊！请阅读群公告～",); // [!code --]
    // 解决方法
    await ctx.pickBot(ctx.self_id).sendGroupMsg(e.group_id, "欢迎加入群聊！请阅读群公告～",); // [!code ++]
})
```

> [!IMPORTANT]
> 无论你是否打算使用多实例，我们都推荐使用 `ctx.pickBot` 进行操作，这有助于插件的分发

## 多实例去重

在连接多个 NapCat 实例的情况下，Mioku 已经自动对消息进行了基本的去重处理。
包括：

消息事件 `message`

请求事件 `request`

群通知事件 `notice`

这会使发送到 Mioku 的同一条消息只有一个实例进行处理

你也可以在插件中自行决定是否需要使用自动去重：

```typescript
export default definePlugin({
  name: 'like-bot',
  setup(ctx) { // [!code focus:13]
    // 禁用去重：每个 bot 都会执行点赞
    ctx.handle(
      'message.group',
      async (event) => {
        if (event.raw_message === '赞我') {
          // 当前 bot 给发送者点赞
          await ctx.bot.like(event.user_id)
          ctx.logger.info(`Bot ${ctx.self_id} 给 ${event.user_id} 点赞`)
        }
      },
      { deduplicate: false }, //标记事件不需要自动去重
    )
  },
})
```

## 权限控制

```typescript
ctx.handle('message', async (e) => {
  // 仅主人可用
  if (!ctx.isOwner(e)) return

  // 仅管理员可用
  if (!ctx.isOwnerOrAdmin(e)) return

  // 仅群管理员可用（群主/管理员）
  if (ctx.isGroupMsg(e)) {
    if (!['owner', 'admin'].includes(e.sender.role)) return
  }
  // ...
})
```

## 任务上下文

```typescript
ctx.cron('0 8 * * *', async (ctx, task) => {
  await ctx.noticeGroups([123456789], '早上好！')
})
```

## 在插件里使用服务

Mioku 提供四个系统服务，分别是 `ai`、`config`、`screenshot` 和 `help`

接下来会分别讲用法，接口类型请从 `mioku` 包导入

插件要先在 `package.json` 里声明依赖的服务：

```json
{
  "mioku": {
    "services": ["config", "screenshot"]
  }
}
```

然后在 `index.ts` 里通过 `ctx.services` 读取：

```typescript
import { definePlugin } from "mioki";
import type { ConfigService, ScreenshotService } from "mioku";

export default definePlugin({ // [!code focus:7]
  name: "hello",
  async setup(ctx) {
    const configService = ctx.services?.config as ConfigService | undefined;
    const screenshotService = ctx.services?.screenshot as ScreenshotService | undefined;
  },
});
```

## 使用配置服务保存插件内容

如果插件需要保存自己的数据或设置，请使用 `config` 服务。

### 注册默认配置

```typescript
import type { ConfigService } from "mioku";

const DEFAULT_CONFIG = {
  reply: "某条神奇的配置内容",
  enabled: true,
};
const configService = ctx.services?.config as ConfigService | undefined;

await configService?.registerConfig("hello", "base", DEFAULT_CONFIG);
```

这会将会生成配置文件：

```text
config/hello/base.json
```

### 读取配置

```typescript
import type { ConfigService } from "mioku";

const configService = ctx.services?.config as ConfigService | undefined;
const config = await configService?.getConfig("hello", "base");

if (!config?.enabled) {
  return;
}

await e.reply(config?.reply || "你好。");
```

### 监听配置变化

```typescript
const dispose = configService?.onConfigChange("hello", "base", (next) => {
  console.log("hello 配置已更新", next);
});
```

## 在插件中截图渲染画面

在 Mioku 框架中，向用户发送自定义的渲染图片例如菜单或插件功能等，最好的方式是通过浏览器渲染一个 HTML 文件截屏后发送给用户。

在 `package.json` 中声明 `screenshot` 服务依赖

```json
{
  "mioku": {
    "services": ["screenshot"]
  }
}
```

然后在插件里读取服务：

```typescript
import type { ScreenshotService } from "mioku";

const screenshotService = ctx.services?.screenshot as ScreenshotService | undefined;
```

### 渲染 HTML 卡片

支持填写 Tailwind 类名

::: code-group

```typescript [index.ts]
import { definePlugin } from "mioki";
import type { ScreenshotService } from "mioku";
import { buildStatusCardHtml } from "./status-card";

export default definePlugin({
  name: "status-card",
  async setup(ctx) {
    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      if (text !== "/状态卡片") {
        return;
      }

      if (!screenshotService) {
        await event.reply("screenshot 服务未加载");
        return;
      }

      const html = buildStatusCardHtml({
        handled: 128,
        failed: 0,
        bots: 2,
      });

      const imagePath = await screenshotService.screenshot(html, {
        width: 960,
        height: 560,
        type: "png",
      });

      await event.reply(ctx.segment.image(imagePath));
    });
  },
});
```

```typescript [status-card.ts]
export function buildStatusCardHtml(stats: {
  handled: number;
  failed: number;
  bots: number;
}): string {
  return `
    <main class="min-h-screen bg-slate-950 text-slate-50 p-10">
      <section class="mx-auto max-w-4xl rounded-[28px] border border-white/10 bg-white/5 p-8 shadow-2xl">
        <div class="text-sm uppercase tracking-[0.3em] text-sky-300/80">
          Mioku Status
        </div>
        <h1 class="mt-3 text-5xl font-bold">今日运行状态正常</h1>
        <div class="mt-8 grid grid-cols-3 gap-4">
          <article class="rounded-2xl bg-white/10 p-5">
            <div class="text-sm text-slate-300">消息处理</div>
            <div class="mt-2 text-3xl font-semibold">${stats.handled}</div>
          </article>
          <article class="rounded-2xl bg-white/10 p-5">
            <div class="text-sm text-slate-300">失败次数</div>
            <div class="mt-2 text-3xl font-semibold">${stats.failed}</div>
          </article>
          <article class="rounded-2xl bg-white/10 p-5">
            <div class="text-sm text-slate-300">在线 Bot</div>
            <div class="mt-2 text-3xl font-semibold">${stats.bots}</div>
          </article>
        </div>
      </section>
    </main>
  `;
}
```

:::

### 使用 React + Tailwind 渲染

::: code-group

```typescript [index.ts]
import { definePlugin } from "mioki";
import type { ScreenshotService } from "mioku";
import { buildDashboardHtml } from "./dashboard-card";

export default definePlugin({
  name: "dashboard-preview",
  async setup(ctx) {
    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      if (text !== "/仪表盘预览") {
        return;
      }

      if (!screenshotService) {
        await event.reply("screenshot 服务未加载");
        return;
      }

      const html = buildDashboardHtml({
        title: "部署完成",
        env: "production",
        successRate: "99.98%",
      });

      const imagePath = await screenshotService.screenshot(html, {
        width: 1100,
        height: 720,
        type: "png",
      });

      await event.reply(ctx.segment.image(imagePath));
    });
  },
});
```

```typescript [dashboard-card.ts]
export function buildDashboardHtml(data: {
  title: string;
  env: string;
  successRate: string;
}): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  return `
    <div id="app"></div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script>window.__CARD_DATA__ = ${payload};</script>
    <script type="text/babel">
      const data = window.__CARD_DATA__;

      function DashboardCard() {
        return (
          <main className="min-h-screen bg-neutral-950 text-white p-10">
            <section className="mx-auto max-w-5xl overflow-hidden rounded-[32px] border border-white/10 bg-gradient-to-br from-slate-900 via-slate-950 to-cyan-950 shadow-2xl">
              <div className="grid grid-cols-[1.4fr_0.8fr]">
                <div className="p-10">
                  <div className="text-xs uppercase tracking-[0.35em] text-cyan-300">
                    Release Dashboard
                  </div>
                  <h1 className="mt-4 text-6xl font-black leading-none">
                    {data.title}
                  </h1>
                  <p className="mt-6 max-w-xl text-lg text-slate-300">
                    当前环境 {data.env}，最近一次发布成功率 {data.successRate}。
                  </p>
                </div>
                <aside className="border-l border-white/10 bg-white/5 p-10">
                  <div className="text-sm text-slate-300">Environment</div>
                  <div className="mt-2 text-3xl font-bold">{data.env}</div>
                  <div className="mt-8 text-sm text-slate-300">Success Rate</div>
                  <div className="mt-2 text-4xl font-black text-cyan-300">
                    {data.successRate}
                  </div>
                </aside>
              </div>
            </section>
          </main>
        );
      }

      ReactDOM.createRoot(document.getElementById("app")).render(<DashboardCard />);
    </script>
  `;
}
```

:::

### 主题模式切换

截图服务支持根据时间自动切换白天/夜间模式，也可以在调用时手动指定主题

```typescript
const imagePath = await screenshotService.screenshot(html, {
  width: 960,
  height: 560,
  type: "png",
  themeMode: "auto", // auto | light | dark
});
```

- `auto`（默认）：根据当前时间自动切换
- `light`：强制使用白天模式
- `dark`：强制使用夜间模式

在 HTML 模板中使用 Tailwind 的 `dark:` 前缀来实现主题适配：

```typescript
export function buildCardHtml(): string {
  return `
    <div class="bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100 p-8">
      <h1 class="text-2xl font-bold text-teal-700 dark:text-teal-300">
        标题
      </h1>
      <p class="text-slate-600 dark:text-slate-400">
        内容文本
      </p>
    </div>
  `;
}
```

### 截图网页

如果你已经有一个可访问的网页，也可以直接截图

```typescript
ctx.handle("message", async (event) => {
  const text = ctx.text(event).trim();
  if (text !== "/官网预览") {
    return;
  }

  if (!screenshotService) {
    await event.reply("screenshot 服务未加载");
    return;
  }

  const imagePath = await screenshotService.screenshotFromUrl(
    "https://example.com",
    {
      width: 1440,
      height: 900,
      fullPage: true,
      waitTime: 1500,
    },
  );

  await event.reply(ctx.segment.image(imagePath));
});
```

## 声明 access hooks

如果希望 bot 的访问控制能按命令/插件/事件类型维度拦截你的插件，需要在 `package.json` 的 `mioku.accessHooks` 列出所有可被外部触发的入口。分两类：

### 文本型 hook（消息事件）

```json
{
  "mioku": {
    "accessHooks": [
      { "id": "60s", "match": "60s" },
      { "id": "油价", "match": "/(.+)油价$/" },
      { "id": "whois", "match": "/^\\/whois\\s+/" }
    ]
  }
}
```

`match` 字段支持两种格式：

- 普通字符串：`text === match` 或 `text.startsWith(match)` 二者命中其一
- `/正则/` 形式：用 `RegExp.test(text)` 判定（不支持 flag，需要大小写不敏感时用 `[Hh][Ee][Ll][Pp]` 这种字符类）

### 事件型 hook（请求/通知事件）

```json
{
  "mioku": {
    "accessHooks": [
      { "id": "auto-friend", "event": "request.friend" },
      { "id": "welcome", "event": "notice.group.increase" }
    ]
  }
}
```

`event` 字段是**前缀匹配**：写 `request` 同时命中 `request.friend` 和 `request.group.invite`；写 `notice.group.increase` 只精确命中这一条。

未声明的入口不会被 access control 拦截（access control 不知道该消息/事件「是不是」给你的，所以默认放行）。完整的访问控制规则、作用域优先级、WebUI 配法见 [访问控制](../guide/access-control.md)。

## 定义插件帮助信息

Mioku 会自动读取 `package.json` 中定义的帮助字段，自动生成帮助图片，无需插件实现截图逻辑

`package.json`

```json
{
  "mioku": {
    "help": {
      "title": "Hello",
      "description": "发送一条问候消息",
      "commands": [
        {
          "cmd": "/hello",
          "desc": "发送问候",
          "usage": "/hello",
          "role": "member"
        }
      ]
    }
  }
}
```

| 字段名称          | 字段内容                                  |
|---------------|---------------------------------------|
| `title`       | 插件标题                                  |
| `description` | 插件简介                                  |
| `commands`    | 命令列表                                  |
| `usage`       | 命令示例                                  |
| `role`        | 权限要求 可选 `member` / `master` / `admin` |

## 数据目录

插件需要持久化数据时，应将数据存放在项目目录下的 `data` 目录中，而不是 `node_modules` 内。

使用 `mioku` 提供的数据路径工具：

```typescript
import {
  getPluginDataDir,
  getPluginConfigDir,
  ensureDataDir,
} from "mioku";

// 获取插件数据目录: {cwd}/data/{pluginName}
const pluginDataDir = getPluginDataDir("my-plugin");

// 确保目录存在
const myDataDir = ensureDataDir("my-plugin");
```

## 在 WebUI 中展示

如果插件希望在 WebUI 里显示配置页面，可以在插件根目录下编写 `config.md` 文件

```text
packages/mioku-plugin-hello/config.md
```

````md
---
title: Hello 插件配置
description: Hello 插件的配置页面
fields:
  - key: base.reply
    label: 回复内容
    type: text
    placeholder: 输入回复内容

  - key: base.enabled
    label: 启用插件
    type: switch
---

# Hello

这个插件会在收到 `/hello` 时回复一条消息

编辑回复内容：

```mioku-field
key: base.reply
```
这里的部分会在 WebUI 渲染成一个输入框

````

这里最重要的是 `fields`：

- `key`：固定格式为 `<configName>.<jsonPath>`
- `label`：字段显示名
- `type`：字段类型
