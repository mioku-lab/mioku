# 在插件中使用 AI

## 声明服务

先在插件的 `package.json` 里声明依赖

```json
{
  "mioku": {
    "services": ["ai"]
  }
}
```

然后在 `index.ts` 里读取服务

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "release-note",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
  },
});
```

> [!TIP]
> 大部分插件不需要自己创建 AI 实例
>
> 正常情况下，直接拿默认实例即可。默认实例通常由 `chat` 插件在启动时创建并设置

## 获取默认 AI 实例

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "release-note",
  async setup(ctx) {  //[!code focus:4]
    const aiService = ctx.services?.ai as AIService | undefined;
    const ai = aiService?.getDefault();
  },
});
```

## 使用默认实例生成文本

最常见的用法就是：给一段明确提示词，让 AI 直接返回可发送的文本

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "release-note",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
    const ai = aiService?.getDefault();
    if (!ai) return;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      if (!text.startsWith("/润色公告 ")) {
        return;
      }

      const draft = text.slice("/润色公告 ".length).trim();
      if (!draft) {
        await event.reply("请先给我一段公告草稿");
        return;
      }

      const polished = await ai.generateText({
        prompt: [
          "你是群公告编辑助手。",
          "保留原意，不要编造新事实",
          "输出 2 到 4 行，语气明确",
        ].join("\n"),
        messages: [{ role: "user", content: draft }],
        temperature: 0.4,
        max_tokens: 180,
      });

      await event.reply(polished.trim());
    });
  },
});
```

当你省略 `model` 时，`ai-service` 会自动读取 `config/chat/base.json` 里的 `model` 作为默认模型

## 使用多模态生成内容

如果你的插件要同时给模型传文字和图片，使用 `generateMultimodal()`

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "poster-review",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
    const ai = aiService?.getDefault();
    if (!ai) return;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      const match = text.match(/^\/检查海报\s+(https?:\/\/\S+)$/);
      if (!match) {
        return;
      }

      const imageUrl = match[1];
      const result = await ai.generateMultimodal({
        prompt: [
          "你是活动运营助手。",
          "请从海报中提取活动名称、时间、地点。",
          "如果文案存在明显问题，也顺手指出来。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "请检查这张活动海报" },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
        temperature: 0.2,
      });

      await event.reply(result.trim() || "没有识别到有效内容");
    });
  },
});
```

## 带工具调用的内容生成

如果你希望模型不只是**写字**，而是**决定什么时候调用插件能力**，用 `complete()`，并传入 `executableTools`

```typescript
import { definePlugin } from "mioki";
import type { AIService, AITool } from "mioku";

export default definePlugin({
  name: "web-ask",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
    const ai = aiService?.getDefault();
    if (!ai) return;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      const [, url, question] = match;

      const response = await ai.complete({
        temperature: 0.2,
        maxIterations: 4,
        messages: [
          {
            role: "system",
            content: [
              "你是网页信息整理助手。",
              "先调用工具读取网页，再根据网页内容回答。",
              "如果网页信息不足，就明确说明。",
            ].join("\n"),
          },
          {
            role: "user",
            content: `${text}`,
          },
        ],
        executableTools: [
          {
            name: "read_webpage",
            tool: {
              name: "read_webpage",
              description: "下载网页并提取标题和正文文本",
              parameters: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "要读取的网页地址",
                  },
                },
                required: ["url"],
              },
              handler: async (args) => {
                const targetUrl = String(args?.url || "").trim();
                if (!targetUrl) {
                  return { success: false, error: "missing url" };
                }

                const resp = await fetch(targetUrl);
                const html = await resp.text();
                const title =
                  html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
                  "";
                const plainText = html
                  .replace(/<script[\s\S]*?<\/script>/gi, " ")
                  .replace(/<style[\s\S]*?<\/style>/gi, " ")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 6000);

                return {
                  success: true,
                  url: targetUrl,
                  title,
                  content: plainText,
                };
              },
            },
          },
        ],
      });

      await event.reply(response.content || "没有拿到可用结果");
    });
  },
});
```

## 使用 `chat` 运行时

`chat-runtime` 不是普通文本生成接口。
它是 `chat` 插件注册到 `ai` 服务上的一层运行时能力，作用是：

- 复用 `chat` 插件当前的人设
- 复用最近对话上下文
- 复用 `chat` 插件自己的发送逻辑

> [!TIP]
> 换句话讲，你的插件可以通过 `chat` 运行时通过 `chat` 插件和用户自然地对话

```typescript
const aiService = ctx.services?.ai as AIService | undefined;
const chatRuntime = aiService?.getChatRuntime();

if (!chatRuntime) {
  ctx.logger.warn("chat-runtime 不可用，请先启用 chat 插件");
  return;
}
```

> [!IMPORTANT]
> `chat-runtime` 由 `chat` 插件注册。
> 如果没启用 `chat` 插件，或者聊天插件初始化失败，`getChatRuntime()` 会返回 `undefined`。

### 用聊天人设发通知

一般用 `generateNotice()`，这个方法的目标很简单，就是让当前人格把这件事自然地说出来

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "video-jobs",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
    const chatRuntime = aiService?.getChatRuntime();
    if (!chatRuntime) return;

    async function notifyJobFinished(event: any, jobId: string) {
      await chatRuntime.generateNotice({
        event,
        instruction: `告诉用户：视频转码已经完成，现在可以发送 /下载 ${jobId} 获取结果`,
        send: true,
      });
    }
  },
});
```

如果你想先预览文本，不立即发送，可以传 `send: false`，然后读取返回值里的 `messages` 继续处理

### 用聊天人设向用户追问缺失信息

询问场景用 `requestInformation()`。
它内部会额外挂一个**提交答案**的工具，让模型在信息足够时把结构化结果交回来。如果信息不够，它就继续追问

```typescript
import { definePlugin } from "mioki";
import type { AIService } from "mioku";

export default definePlugin({
  name: "reminder",
  async setup(ctx) {
    const aiService = ctx.services?.ai as AIService | undefined;
    const chatRuntime = aiService?.getChatRuntime();
    if (!chatRuntime) return;

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();
      if (text !== "/提醒我") {
        return;
      }

      const result = await chatRuntime.requestInformation({
        event,
        task: "帮当前用户补全创建提醒任务所需的信息",
        schema: {
          type: "object",
          properties: {
            time: {
              type: "string",
              description: "提醒时间，例如 今天 23:30、明天早上 8 点",
            },
            content: {
              type: "string",
              description: "提醒内容",
            },
            repeat: {
              type: "string",
              description: "可选，重复规则，例如 每周一到周五",
            },
          },
          required: ["time", "content"],
        },
        send: true,
      });

      const info = result.collectedInfo;
      if (!info?.isComplete || !info.data) {
        return;
      }

      await event.reply(
        `提醒已创建：${info.data.time} - ${info.data.content}`,
      );
    });
  },
});
```

## 默认 AI 实例和 `chat-runtime` 的区别

| 场景                     | 推荐方式                                | 原因                     |
|------------------------|-------------------------------------|------------------------|
| 总结文本、改写公告、解析参数         | 默认 AI 实例                            | 你完全控制提示词、消息和工具         |
| 让模型调用插件里的本地工具          | 默认 AI 实例 + `complete()`             | 你可以传 `executableTools` |
| 想让消息保持 `chat` 插件的人设和语气 | `chat-runtime.generateNotice()`     | 直接复用聊天人格和上下文           |
| 想让聊天人格代你向用户补齐字段        | `chat-runtime.requestInformation()` | 自带提交答案工具和追问流程          |

- 默认 AI 实例更像**你自己在直接调模型**
- `chat-runtime` 更像**请聊天插件代你开口**

## 编写 `skills.ts`

如果你想把插件能力暴露给 AI，可以在插件目录下编写 `skills.ts` 文件

Mioku 会在启动时自动扫描插件目录下的 `skills.ts`，并注册里面 `default-export` 出来的 `AISkill[]`

> [!NOTE]
> 提供 `skills` 可以让 `chat` 插件中的 AI 使用插件中的功能

```typescript
import type { AISkill, AITool, HelpService } from "mioku";
import { buildHelpInfoText } from "./shared";

const helpSkills: AISkill[] = [
  {
    name: "help",
    description: "帮助系统，获取插件帮助信息和发送帮助图片",
    permission: "member",
    tools: [
      {
        name: "get_help_info",
        description: "获取所有插件的帮助信息文本",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
        handler: async (_args: any, runtimeCtx?: any) => {
          const ctx = runtimeCtx?.ctx;
          const helpService = ctx?.services?.help as HelpService | undefined;
          if (!helpService) {
            return "help-service 未加载，无法获取帮助信息";
          }

          return buildHelpInfoText(helpService.getAllHelp());
        },
      } as AITool,
    ],
  },
];

export default helpSkills;
```

- `skills.ts` 默认导出的是 `AISkill[]`
- `AISkill.permission` 可选，支持 `member` / `admin` / `owner`，未填写默认 `member`
- 权限含义：`owner`=mioki 主人；`admin`=mioki 管理 + 群管 + 群主；`member`=普通成员
- 工具处理函数可以通过 `runtimeCtx?.ctx` 访问当前上下文
- 如果需要读取 `setup()` 创建的可变对象，不要依赖模块局部变量，使用 `runtime.ts` + Mioku runtime registry

注册后，工具会以 `skillName.toolName` 的形式被识别

如果 `chat` 插件启用了外部技能，它会在三处做权限校验：

- 提示词中的"已加载外部技能"列表会按触发用户权限过滤
- `load_skill` 时会检查触发用户是否满足 `AISkill.permission`
- 技能工具实际调用时会再次校验，权限不足会拒绝执行

## 使用 `runtime.ts` 解决 `index.ts` 闭包

`help` 这种工具比较简单，直接从 `runtimeCtx?.ctx` 里拿服务就够了

但更复杂的插件往往会在 `setup()` 里创建一些只能运行时存在的对象，比如：

- 循环管理器
- 长连接客户端
- 缓存和会话状态
- 由配置拼出来的服务包装层

问题在于：`skills.ts` 不是在插件 `setup()` 内执行的，它会被框架单独导入

所以它不能直接引用 `setup()` 里的局部变量，这时就需要 `runtime.ts` 做桥接。

> [!IMPORTANT]
> 不要把 `runtime.ts` 写成模块内局部变量单例，例如 `const runtimeState = {}`
>
> 原因有两个：
>
> - `skills.ts` 和插件本体可能通过不同加载路径被导入
> - `mioki` 当前内部使用的 `jiti` 明确关闭了 `moduleCache`
>
> 这意味着同一个 `runtime.ts` 文件可能被执行多次，模块级变量不会稳定共享
>
> 在 Mioku 里，推荐使用 `mioku` 包提供的全局 runtime registry

```typescript
// runtime.ts 示例
import type { QueueManager } from "./queue-manager";
import {
  getPluginRuntimeState,
  resetPluginRuntimeState,
  setPluginRuntimeState,
} from "mioku";

export interface NoticeRuntimeState {
  queue?: QueueManager;
  webhookUrl?: string;
}

const PLUGIN_NAME = "notice-center";

export function setNoticeRuntimeState(nextState: NoticeRuntimeState) {
  return setPluginRuntimeState<NoticeRuntimeState>(PLUGIN_NAME, nextState);
}

export function getNoticeRuntimeState(): NoticeRuntimeState {
  return getPluginRuntimeState<NoticeRuntimeState>(PLUGIN_NAME);
}

export function resetNoticeRuntimeState(): void {
  resetPluginRuntimeState(PLUGIN_NAME);
}
```

在 `index.ts` 的 `setup()` 里，把运行时对象塞进去：

```typescript
// index.ts
import { definePlugin } from "mioki";
import { QueueManager } from "./queue-manager";
import {
  resetNoticeRuntimeState,
  setNoticeRuntimeState,
} from "./runtime";

export default definePlugin({
  name: "notice-center",
  async setup(ctx) {
    const queue = new QueueManager(ctx.logger);
    const webhookUrl = process.env.NOTICE_WEBHOOK_URL || "";

    setNoticeRuntimeState({
      queue,
      webhookUrl,
    });

    return () => {
      resetNoticeRuntimeState();
    };
  },
});
```

`skills.ts` 再去读取这些状态：

```typescript
// skills.ts
import type { AISkill } from "mioku";
import { getNoticeRuntimeState } from "./runtime";

const noticeSkills: AISkill[] = [
  {
    name: "notice_center",
    description: "通知中心工具",
    tools: [
      {
        name: "push_notice",
        description: "推送一条站内通知",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
        },
        handler: async (args) => {
          const { queue, webhookUrl } = getNoticeRuntimeState();
          if (!queue || !webhookUrl) {
            return { error: "runtime is not ready" };
          }

          return queue.push({
            title: args.title,
            content: args.content,
            webhookUrl,
          });
        },
      },
    ],
  },
];

export default noticeSkills;
```

这样 `skills.ts` 既不会依赖 `setup()` 的局部闭包，又能稳定拿到真正的运行时对象。