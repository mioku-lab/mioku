# 开发插件入门

> [!NOTE]
> 部分示例代码来自 [mioki 官方文档](https://mioki.viki.moe/plugin.html)。

## 命名规范

Mioku 中对插件命名的要求：

- npm 包名：`mioku-plugin-name`
- 插件目录：`packages/mioku-plugin-name/`
- 启用插件名：`name`

例如你要写一个天气插件：

- npm 包名：`mioku-plugin-weather`
- 插件目录：`packages/mioku-plugin-weather/`
- 启用插件名：`weather`

## 插件目录结构

一个基础的插件，只需要这两个文件：

```text
packages/mioku-plugin-weather/
  index.ts
  package.json
```

其中：

- `index.ts`：插件运行入口
- `package.json`：插件的基本信息

当然，我们推荐把复杂的逻辑从 `index.ts` 中分离出来方便管理。

## 开始编写一个插件

下面以 `weather` 插件为例

```bash
mkdir -p packages/mioku-plugin-weather
cd packages/mioku-plugin-weather
```

新建 `package.json`

写入下面这份配置

```json
{
  "name": "mioku-plugin-weather",
  "version": "1.0.0",
  "description": "天气插件",
  "main": "index.ts",
  "type": "module",
  "keywords": ["mioku"],
  "repository": {
    "type": "git",
    "url": "https://github.com/yourname/mioku-plugin-weather.git"
  },
  "peerDependencies": {
    "mioku": "^0.8.0",
    "mioki": "^0.16.0"
  },
  "mioku": {
    "services": [],
    "help": {
      "title": "天气",
      "description": "天气插件示例",
      "commands": [
        {
          "cmd": "/天气",
          "desc": "查询天气",
          "usage": "/天气 北京",
          "role": "member"
        }
      ]
    }
  }
}
```

package 字段如下

| 字段               | 类型         | 必填 | 说明                         |
|------------------|------------|----|----------------------------|
| `name`           | `string`   | ✅  | 推荐使用 `mioku-plugin-<name>` |
| `version`        | `string`   | ✅  | 插件版本号                      |
| `description`    | `string`   | ❌  | 插件描述                       |
| `main`           | `string`   | ✅  | 插件入口文件，一般写 `index.ts`      |
| `type`           | `string`   | ✅  | 必须为 `module`               |
| `keywords`      | `string[]` | ❌  | 推荐包含 `mioku`              |
| `peerDependencies` | `object` | ✅  | 必须依赖 `mioku` 和 `mioki`   |
| `mioku.services` | `string[]` | ❌  | 插件依赖的 Mioku 服务名称           |
| `mioku.help`     | `object`   | ❌  | 插件帮助信息，Mioku 会自动读取         |

`mioku` 配置块常用字段如下

| 字段         | 类型         | 必填 | 说明                                      |
|------------|------------|----|-----------------------------------------|
| `services` | `string[]` | ❌  | 声明插件依赖的服务，例如 `config`、`screenshot`、`ai` |
| `help`     | `object`   | ❌  | 插件帮助信息，Mioku 会自动收集                      |

## 编写 `index.ts`

现在再写一个入口文件，插件就可以运行了

```typescript
import { definePlugin } from "mioki";

export default definePlugin({
  name: "weather",
  version: "1.0.0",
  description: "天气插件",

  async setup(ctx) {
    ctx.handle("message", async (event) => {
      // 读取消息中的文本
      const text = ctx.text(event).trim();
      const match = text.match(/^\/天气\s+(.+)$/);
      if (!match) {
        return;
      }
      const city = match[1];
      // 回复一条消息
      await event.reply(`${city}：晴，26°C，适合出门。`);
    });
  },
});
```

## `definePlugin` 字段说明

插件的运行入口通过 `definePlugin({...})` 定义

```typescript
export default definePlugin({
  name: "demo",
  version: "1.0.0",
  priority: 100,
  description: "示例插件",
  dependencies: [],
  setup(ctx) {},
});
```

插件结构字段如下

| 属性             | 类型         | 必填 | 说明                      |
|----------------|------------|----|-------------------------|
| `name`         | `string`   | ✅  | 插件唯一标识，应与插件目录名一致        |
| `version`      | `string`   | ❌  | 插件版本号，推荐使用语义化版本         |
| `priority`     | `number`   | ❌  | 加载优先级，数值越小越先加载，默认 `100` |
| `description`  | `string`   | ❌  | 插件描述信息                  |
| `dependencies` | `string[]` | ❌  | 插件依赖，仅供参考，框架不处理         |
| `setup`        | `function` | ❌  | 插件初始化函数，接收上下文对象         |

## 上下文对象

`ctx` 就是插件运行时的上下文对象。
平时写插件，大部分工作都会围绕它展开

部分用法如下

```typescript
// 机器人实例（当前处理事件的 bot）
ctx.bot; // NapCat 实例

// 所有已连接的 bot 列表
ctx.bots; // ExtendedNapCat[]

// 当前 bot 的 QQ 号
ctx.self_id; // number

// 机器人信息
ctx.bot.uin; // QQ 号
ctx.bot.nickname; // 昵称

// 消息构造器
ctx.segment; // 消息段构造器

// 日志器
ctx.logger; // 插件专属日志器

// 事件去重器
ctx.deduplicator; // Deduplicator

// 框架配置
ctx.botConfig;

ctx.handle("message", async (event) => {
  // 检查发消息的人是不是主人
  const owner = ctx.isOwner(event);

  // 检查发消息的人是不是管理员
  const admin = ctx.isAdmin(event);

  ctx.logger.info(`owner=${owner} admin=${admin}`);
});
```

更完整的接口说明请看

- [ctx 与事件](/reference/ctx)
- [mioki API](/reference/mioki-api)

## 常用 API

写基础插件时，最常用的是下面这些

| API                  | 说明             |
|----------------------|----------------|
| `ctx.handle()`       | 注册事件处理器        |
| `ctx.text(event)`    | 获取消息纯文本        |
| `ctx.match()`        | 快速做关键词匹配       |
| `ctx.segment`        | 构造消息段          |
| `ctx.pickBot(id)`    | 多实例场景下选择指定 bot |
| `ctx.cron()`         | 注册定时任务         |
| `ctx.logger`         | 输出插件日志         |
| `ctx.isOwner(event)` | 判断是否为主人        |
| `ctx.isAdmin(event)` | 判断是否为管理员       |

## 事件监听器

使用 `ctx.handle()` 注册事件监听器

```typescript
// 监听所有消息
ctx.handle('message', async (event) => {
    ctx.logger.info(`收到消息：${event.raw_message}`)
})

// 仅监听群消息
ctx.handle('message.group', async (event) => {
    ctx.logger.info(`收到群 ${event.group_id} 的消息`)
})

// 仅监听私聊消息
ctx.handle('message.private', async (event) => {
    ctx.logger.info(`收到来自 ${event.user_id} 的私聊消息`)
})

// 监听通知事件
ctx.handle('notice', async (event) => {
    ctx.logger.info(`收到通知：${event.notice_type}`)
})

// 监听请求事件
ctx.handle('request.friend', async (event) => {
    ctx.logger.info(`收到好友请求：${event.user_id}`)
    await event.approve() // 自动同意
})
```

## 定时任务

使用 `ctx.cron()` 注册定时任务

```typescript
// 每小时执行一次
ctx.cron("0 * * * *", async (_ctx, task) => {
  // task.date 是这次调度的触发时间
  ctx.logger.info(`定时任务执行时间: ${task.date.toISOString()}`);
});
```

每天早上九点执行

```typescript
ctx.cron("0 9 * * *", async () => {
  ctx.logger.info("早安任务开始");
});
```

## 消息回复

最简单的回复就是直接使用 `event.reply()`

```typescript
ctx.handle("message", async (event) => {
  if (ctx.text(event).trim() === "/hello") {
    // 最基础的文字回复
    await event.reply("你好");
  }
});
```

引用回复

```typescript
ctx.handle("message", async (event) => {
  if (ctx.text(event).trim() === "/quote") {
    // 第二个参数为 true 时会引用回复
    await event.reply("这是一条引用回复", true);
  }
});
```

## 消息段构造

使用 `ctx.segment` 构造各种各样的消息段

```typescript
ctx.handle('message', async (event) => {
    // 纯文本
    ctx.segment.text('Hello')

    // @某人
    ctx.segment.at(123456789)
    ctx.segment.at('all') // @全体成员

    // QQ 表情
    ctx.segment.face(66) // 爱心表情

    // 图片
    ctx.segment.image('https://example.com/image.png')
    ctx.segment.image('file:///path/to/image.png')
    ctx.segment.image('base64://...')

    // 语音
    ctx.segment.record('https://example.com/audio.mp3')

    // 视频
    ctx.segment.video('https://example.com/video.mp4')

    // JSON 卡片
    ctx.segment.json('{"app":"com.tencent.xxx",...}')

    // 合并转发
    ctx.segment.forward('转发消息ID')

    // 回复
    ctx.segment.reply('消息ID')

    // 组合发送
    await event.reply([
        ctx.segment.at(event.user_id),
        ' 这是一条测试消息 ',
        ctx.segment.face(66),
        ctx.segment.image('https://example.com/image.png'),
    ])
})
```

## 消息匹配

精确匹配

```typescript
ctx.handle('message', (e) => {
  if (e.raw_message === 'hello') {
    e.reply('mioku')
  }
})
```

包含匹配

```typescript
ctx.handle('message', (e) => {
  if (e.raw_message.includes('早上好')) {
    e.reply('不好也可以')
  }
})
```

使用正则

```typescript
ctx.handle('message', (e) => {
  const match = e.raw_message.match(/^签到(\d+)?$/)
  if (match) {
    const times = match[1] ? parseInt(match[1]) : 1
    e.reply(`签到 ${times} 次成功`)
  }
})
```

使用 `ctx.match()` 函数

```typescript
ctx.handle('message', (e) => {
    ctx.match(e, {
        // 字符串匹配
        hello: 'world',
        ping: 'pong',

        // 动态回复
        时间: () => new Date().toLocaleString(),

        // 异步回复
        天气: async () => {
            const data = await fetchWeather()
            return `今日天气：${data.weather}`
        },

        // 返回消息段数组
        测试: () => [ctx.segment.text('测试成功 '), ctx.segment.face(66)],

        // 返回 null/undefined/false 则不回复
        静默: () => null,
    })
})
```

带参数的写法

```typescript
ctx.handle("message", async (event) => {
  await ctx.match(event, {
    "/echo *": (matches) => {
      // matches[1] 是通配部分
      return `你刚刚说的是：${matches[1]}`;
    }
  });
});
```

使用 `mri` 对复杂指令进行解析

```typescript
ctx.handle('message', (e) => {
    // 使用 mri 解析命令行参数
    const { cmd, params, options } = ctx.createCmd(e.raw_message, {
        prefix: '/',
    })

    if (cmd === 'ban') {
        const [userId, duration] = params
        const reason = options.reason || '违规'
        // 执行禁言
    }

    if (cmd === 'echo') {
        e.reply(params.join(' '))
    }
})
```

## 插件清理

`setup()` 可以返回一个清理函数，在插件卸载时自动执行。

```typescript
// 启动一个普通定时器
const timer = setInterval(() => {
  ctx.logger.info("定时器运行中");
}, 5000);

// setup 返回的函数会在插件卸载时自动执行
return () => {
  clearInterval(timer);
  ctx.logger.info("插件已卸载，定时器已清理");
};
```

## 启用插件

插件安装后，Mioku 会自动发现并加载插件。

## 测试插件

向机器人发送：

```text
/天气 北京
```

如果收到回复，说明插件已经可以正常运行。

## 插件示例

> 以下示例插件均来自 `mioki` 官方文档。

::: code-group

```ts [复读机插件]
import { definePlugin } from 'mioki'

export default definePlugin({
  name: 'repeater',
  version: '1.0.0',
  setup(ctx) {
    ctx.handle('message.group', async (event) => {
      if (event.raw_message === '复读') {
        const lastMessage = event.message
          .filter((m) => m.type === 'text')
          .map((m) => m.text)
          .join('')

        if (lastMessage) {
          await event.reply(lastMessage)
        }
      }
    })
  },
})
```

```ts [入群欢迎插件]
import { definePlugin } from 'mioki'

export default definePlugin({
  name: 'welcome',
  version: '1.0.0',
  setup(ctx) {
    ctx.handle('notice.group.increase', async (event) => {
      await event.group.sendMsg([
        ctx.segment.at(event.user_id),
        ' 欢迎加入群聊！请阅读群公告～',
      ])
    })
  },
})
```

```ts [自动审批插件]
import { definePlugin } from 'mioki'

export default definePlugin({
  name: 'auto-approve',
  version: '1.0.0',
  setup(ctx) {
    // 自动同意好友请求
    ctx.handle('request.friend', async (event) => {
      ctx.logger.info(`自动同意好友请求：${event.user_id}`)
      await event.approve()
    })

    // 自动同意入群申请（包含特定答案）
    ctx.handle('request.group.add', async (event) => {
      if (event.comment.includes('暗号')) {
        ctx.logger.info(`自动同意入群申请：${event.user_id}`)
        await event.approve()
      } else {
        await event.reject('请填写正确的暗号')
      }
    })
  },
})
```

:::