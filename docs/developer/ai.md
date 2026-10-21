---
title: 使用 AI 服务
description: 使用内置 AI 服务获取实例、生成文本、注册工具，并使用聊天运行时。
---

# 使用 AI 服务

Mioku 内置了 AI 服务，服务名是 `ai`。它统一管理接入哪家 API、使用哪个模型和暴露哪些工具。插件不需要自己填写 apiKey，从服务中取一个实例即可对话，也可以把自己的功能做成工具交给模型调用。

## 概念

先认识五个概念。

| 概念 | 是什么 |
| --- | --- |
| provider | 一个 API 连接配置，包含接口地址、apiKey 和协议。协议可选 `openai-chat`、`openai-response`、`anthropic` 和 `gemini` |
| model | 模型描述，挂在某个 provider 下，带能力标记和上下文窗口大小。能力标记可选 `text`、`vision`、`tool-use` 和 `reasoning` |
| instance | 由提供商和模型绑定出的调用句柄，插件直接打交道的对象 |
| skill | 一组工具的集合，可以带权限。注册进服务后模型就能调用其中的工具 |
| tool | 暴露给模型调用的函数，何时调用由模型自己决定 |

## 获取实例

实例按用途分为三种角色。

| 角色 | 用途 |
| --- | --- |
| `main` | 主对话，日常聊天 |
| `working` | 后台任务，例如总结和翻译这类消耗 token 的批量工作 |
| `vision` | 看图，处理多模态输入 |

推荐使用下面的方式获取。

```typescript
import { requireService, Services } from "mioku";
import type { AIInstance } from "mioku";

const aiService = requireService(ctx, Services.AI);

const main: AIInstance | undefined =
  aiService.getInstanceByRole?.("main") ?? aiService.getDefault();
const working: AIInstance | undefined =
  aiService.getInstanceByRole?.("working") ?? main;
const vision: AIInstance | undefined =
  aiService.getInstanceByRole?.("vision") ?? working;
```

这段代码优先取绑定了角色的实例，取不到时逐级退化。`main` 退到默认实例，`working` 退到 `main`，`vision` 退到 `working`。这样用户只配置了一个模型时，插件也能运行。

`getInstanceByRole` 和 `getDefault` 都可能返回 `undefined`，用户完全没有配置 AI 时就是如此。可以在 `setup` 中判空后提前退出，也可以在 handler 中现取现判。

实例带有名字，`aiService.get(name)` 可以按名字精确获取，`aiService.listInstances?.()` 可以列出全部实例及其所属 provider、模型和角色。多数场景使用上面的退化写法即可。

## 生成文本

`generateText` 最常用，传入消息后返回字符串。

```typescript
const answer = await main.generateText({
  prompt: "你是一个简洁的助手，回答不超过三句话。",
  messages: [
    { role: "user", content: "用一句话解释什么是闭包" },
  ],
});
```

参数是一个对象。

| 参数 | 说明 |
| --- | --- |
| `messages` | 必填，`{ role, content }` 数组，role 支持 `system`、`user` 和 `assistant` |
| `prompt` | 可选，会被拼到最前面作为 system 消息 |
| `model` | 可选，临时更换模型 |
| `temperature` / `max_tokens` | 可选，控制采样与输出长度 |

多轮对话时把历史按顺序放进 `messages`，assistant 的历史回复也原样放入。

```typescript
const reply = await main.generateText({
  messages: [
    { role: "system", content: "你是一个猜谜游戏的主持人" },
    { role: "user", content: "开始吧" },
    { role: "assistant", content: "好，我心里已经有个东西了，提问吧" },
    { role: "user", content: "是动物吗" },
  ],
});
```

## 处理图片

`generateMultimodal` 的参数形状与 `generateText` 相同，区别是消息的 `content` 可以是数组，用于图文混排。

```typescript
const desc = await vision.generateMultimodal({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图里是什么，用一句话回答" },
        { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
      ],
    },
  ],
});
```

图片放在 `image_url.url` 中，`detail` 可选 `auto`、`low` 或 `high`，用于控制识别精度。多张图片就放多个 `image_url` 项。

::: tip 使用 vision 实例
用户可能把 `vision` 角色绑定到支持视觉的模型上。看图时应按上面的退化逻辑取 `vision` 实例，不要使用 `main`。
:::

## 调用工具

工具调用是 AI 服务中功能最强的部分。流程是定义工具，打包成技能注册，然后使用 `generateWithTools` 对话，模型认为需要时会自行调用。

下面是一个查询天气的插件。

```typescript
import { definePlugin, getService, Services } from "mioku";
import type { AITool, AISkill } from "mioku";

const weatherTool: AITool = {
  name: "query_weather",
  description: "查询指定城市的当前天气，用户问到天气相关问题时调用",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名，例如上海" },
    },
    required: ["city"],
  },
  handler: async (args) => {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(args.city)}?format=j1`,
    );
    const data = await res.json();
    const now = data.current_condition?.[0];
    if (!now) return `${args.city}：查询失败`;
    return `${args.city} 现在 ${now.temp_C}°C，${now.weatherDesc?.[0]?.value ?? "未知"}`;
  },
};

const weatherSkill: AISkill = {
  name: "weather",
  description: "天气查询",
  permission: "member",
  tools: [weatherTool],
};

export default definePlugin({
  name: "weather",
  async setup(ctx) {
    const aiService = getService(ctx, Services.AI);
    if (!aiService) {
      ctx.logger.warn("ai 服务未加载，天气技能不会注册");
      return;
    }
    aiService.registerSkill(weatherSkill);

    ctx.handle("message", async (event) => {
      const text = ctx.text(event);
      if (!text.includes("天气")) return;

      const instance =
        aiService.getInstanceByRole?.("main") ?? aiService.getDefault();
      if (!instance) return;

      const result = await instance.generateWithTools({
        messages: [{ role: "user", content: text }],
      });
      await event.reply(result.content);
    });
  },
});
```

运行后，用户发送一条询问天气的消息，模型会自行决定调用 `query_weather`，拿到结果再组织成回答。插件不需要编写判断意图、调用接口和拼接回复的中间逻辑。

有几点需要说明。

**工具的四个字段。** `name` 和 `description` 是给模型看的。description 写得越具体，越能说明什么情况下应该调用，模型判断得也越准。`parameters` 是 JSON Schema，描述入参。`handler` 是实现，`args` 是模型给出的参数。模型传入的参数不一定正确，handler 中需要做好校验。

**工具必须包在技能中注册。** 服务上没有注册单个工具的入口，`registerSkill(skill)` 一次注册一个技能，技能中的全部工具会一起进入。同名技能会被覆盖，日志中会有警告。`AITool` 的完整定义见[类型参考](/reference/api/interfaces/AITool)。

**generateWithTools 会自动带上所有已注册技能的工具。** 它内部收集所有技能的工具，工具名会加上技能名前缀，例如 `weather.query_weather`，然后交给模型挑选。模型调用后框架自动执行 handler 并把结果送回模型，循环直到模型给出最终回答。返回值如下。

| 字段 | 说明 |
| --- | --- |
| `content` | 最终回答文本 |
| `iterations` | 实际执行了几轮工具循环 |
| `allToolCalls` | 本轮对话中发生过的所有工具调用，包含名称、参数和结果 |

**handler 中可以访问调用现场。** handler 的第二个参数是调用现场。聊天插件调用工具时会带上 `ctx` 和 `event`，工具可以直接在其中回复消息或取服务。help 插件的 `send_help_image` 工具就是用这种方式把生成的帮助图片发送出去的。该参数是可选的，其他调用方可能不传，使用前需要判空。

```typescript
handler: async (args, runtimeCtx?) => {
  const ctx = runtimeCtx?.ctx;
  const event = runtimeCtx?.event ?? runtimeCtx?.rawEvent;
  if (ctx && event) {
    await event.reply("图片已生成");
  }
  return "done";
},
```

## 技能权限

`AISkill` 的 `permission` 字段声明该技能开放给哪类用户。

| 值 | 谁 |
| --- | --- |
| `member` | 任意成员，默认值。写入非法值时也会回退到它 |
| `admin` | bot 主人或管理员 |
| `master` | 仅 bot 主人 |
| `owner` | `master` 的旧写法，等价 |

权限的实际拦截发生在调用方。例如 chat 插件会按触发用户的角色过滤技能，角色等级不足的技能不会进入模型。AI 服务本身只负责存取，因此即使工具被高权限技能包裹，handler 中该做的参数校验依然不能省略。

## 聊天运行时

chat 插件 `mioku-plugin-chat` 把一套让 AI 说话的能力注册到了 AI 服务上，称为 ChatRuntime。其他插件可以借它让 AI 用自然语言发送通知，或者按指定格式收集结构化信息，不需要自己编写 prompt 和工具循环。获取方式如下。

```typescript
const aiService = getService(ctx, Services.AI);
const chatRuntime = aiService?.getChatRuntime();
```

chat 插件是系统插件，默认会安装，但用户可能禁用它。`getChatRuntime()` 返回 `undefined` 时需要判空。

### 生成通知

`generateNotice` 用于让 AI 生成一条自然的通知。场景是插件想提醒群成员一件事，但不希望语气过于机械。传入一个 `event` 或 `selfId` 与 `groupId`，再加 `instruction`，chat 插件会让 AI 结合上下文组织语言并发送。

```typescript
const chatRuntime = aiService?.getChatRuntime();
if (chatRuntime) {
  await chatRuntime.generateNotice({
    event,                // 复用当前消息事件的上下文，包含群号和用户
    instruction: "提醒大家明天下午三点团建，楼下集合",
    send: true,           // 生成后直接发送
    promptInjections: [   // 可选，附加指令，约束 AI 的语气
      { title: "Notice", content: "用轻松的语气，不要提到任何插件或命令。" },
    ],
  });
}
```

常用参数如下。

| 参数 | 说明 |
| --- | --- |
| `event` / `selfId` 加 `groupId` / `selfId` 加 `userId` | 通知发送到哪里，可以传事件、群目标或私聊目标 |
| `instruction` | 要表达的内容，必填 |
| `send` | 生成后是否直接发送，默认 `true` |
| `targetMessage` | 可选，喂给 AI 的额外上下文 |
| `promptInjections` | 可选，附加提示词，约束语气和行为 |

返回值是 `ChatRuntimeResult`，包含生成的消息和工具调用记录。`send` 为 `true` 时消息已经发出，一般不需要使用返回值。

### 收集信息

`requestInformation` 让 AI 在对话中收集结构化信息，例如询问用户的生日、城市和星座。传入一个 `task` 和 JSON Schema 格式的 `schema`，AI 会通过工具把收集到的数据提交回来。

```typescript
const result = await chatRuntime.requestInformation({
  event,
  task: "询问用户的生日、所在城市和星座",
  schema: {
    type: "object",
    properties: {
      birthday: { type: "string", description: "生日，格式 YYYY-MM-DD" },
      city: { type: "string" },
      zodiac: { type: "string", description: "星座" },
    },
    required: ["birthday", "city", "zodiac"],
  },
});

const data = result.collectedInfo?.data; // 收集到的结构化数据
```

`collectedInfo.data` 是 AI 提交的数据对象，`isComplete` 标记是否收集完整，`confidence` 是置信度，`notes` 是 AI 的补充说明。收集不完整时 `data` 可能是 `undefined`，使用前需要判空。

完整定义见 [ChatRuntime](/reference/api/interfaces/ChatRuntime) 和 [ChatRuntimeResult](/reference/api/interfaces/ChatRuntimeResult)。

## 精细控制

`generateText` 和 `generateWithTools` 都是 `complete()` 的快捷方式。需要流式输出或手动接管工具循环时，可以直接使用它。

```typescript
const res = await instance.complete({
  messages: [{ role: "user", content: "给我讲个冷笑话" }],
  stream: true,
  onTextDelta: (delta) => {
    process.stdout.write(delta); // 流式输出的每个增量片段
  },
});

res.content;   // 完整文本
res.reasoning; // 推理模型的思考过程，存在时才有
res.toolCalls; // 模型请求的工具调用
```

`CompleteOptions` 中需要了解的选项如下。

| 选项 | 说明 |
| --- | --- |
| `messages` | 必填，消息数组 |
| `stream` / `onTextDelta` | 流式输出，每个增量文本都会进入回调 |
| `executableTools` | 会话内可执行的工具，传入后框架自动进入工具循环 |
| `executableToolsProvider` | 同上，但每轮循环时现取，适合工具集动态变化的场景 |
| `maxIterations` | 工具循环的最大轮数，防止模型无限调用工具 |
| `model` / `temperature` / `max_tokens` | 与 `generateText` 相同 |

返回的 `CompleteResponse` 除上述字段外还有 `iterations` 和 `allToolCalls`，定义见[类型参考](/reference/api/interfaces/CompleteResponse)。

## 思考等级

推理模型可以调整思考强度，`AIThinkingLevel` 共六档：`off`、`low`、`medium`、`high`、`xhigh` 和 `max`。Gemini 协议只支持到 `high`，更高的值会被忽略。设置方式为 `aiService.setModelThinkingLevel?.(modelFullId, level)`，一般由用户在 WebUI 中调整。

## 下一步

- [插件间通信](/developer/communicate)：获取 AI 服务实例
- [AIService 类型参考](/reference/api/interfaces/AIService)：服务的完整接口
- [AIInstance 类型参考](/reference/api/interfaces/AIInstance)：实例的方法
