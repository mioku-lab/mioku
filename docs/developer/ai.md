# 使用 AI 服务

Mioku 内置了一个 AI 服务（`ai`），把「接哪家 API、用哪个模型、暴露哪些工具」统一管起来。插件不用自己填 apiKey，从服务里拿一个实例就能聊，还能把自己的功能做成工具交给模型调用。

## 几个概念

先认识五个词，后面一直在跟它们打交道：

| 概念       | 是什么                                                                                    |
|----------|----------------------------------------------------------------------------------------|
| provider | 一个 API 连接配置：接口地址、apiKey、协议（`openai-chat` / `openai-response` / `anthropic` / `gemini`） |
| model    | 模型描述，挂在某个 provider 下，带能力标记（`text` / `vision` / `tool-use` / `reasoning`）、上下文窗口大小       |
| instance | 「提供商 + 模型」绑定出来的调用句柄，插件真正打交道的对象                                                         |
| skill    | 一组工具的集合，可以带权限，注册进服务后模型就能调用里面的工具                                                        |
| tool     | 暴露给模型调用的函数，什么时候调由模型自己决定                                                                |

## 拿到一个实例

实例按用途分了三种角色：

| 角色        | 用途                       |
|-----------|--------------------------|
| `main`    | 主对话，日常聊天                 |
| `working` | 干活，后台总结、翻译这类费 token 的批量活 |
| `vision`  | 看图，处理多模态输入               |

推荐这样取（chat 插件的思路，简化版）：

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

逻辑很直白：优先拿绑定了角色的实例，拿不到就逐级退化——main 退到默认实例，working 退到 main，vision 退到 working。这样用户哪怕只配了一个模型，你的插件也能跑。

注意 `getInstanceByRole` 和 `getDefault` 都可能返回 undefined——用户压根没配 AI 的时候就是如此。要么在 setup 里判空提前退出（学 help 插件：warn 一句然后不注册功能），要么在 handler 里现取现判。

顺带一提，实例是有名字的，`aiService.get(name)` 能按名字精确取，`aiService.listInstances?.()` 列出全部（带所属 provider、模型和角色）。不过绝大多数场景，用上面的退化写法就够了。

## 发文本：generateText

最常用的一个，给消息，回字符串：

```typescript
const answer = await main.generateText({
  prompt: "你是一个简洁的助手，回答不超过三句话。",
  messages: [
    { role: "user", content: "用一句话解释什么是闭包" },
  ],
});
```

参数是一个对象：

| 参数 | 说明 |
| --- | --- |
| `messages` | 必填，`{ role, content }` 数组，role 支持 `system` / `user` / `assistant` |
| `prompt` | 可选，会被拼到最前面当 system 消息 |
| `model` | 可选，临时换模型 |
| `temperature` / `max_tokens` | 可选，老朋友了 |

多轮对话就把历史按顺序塞进 `messages`，assistant 的历史回复也原样放进去：

```typescript
const reply = await main.generateText({
  messages: [
    { role: "system", content: "你是一个猜谜游戏的主持人" },
    { role: "user", content: "开始吧" },
    { role: "assistant", content: "好，我心里已经有个东西了，提问吧！" },
    { role: "user", content: "是动物吗？" },
  ],
});
```

## 看图：generateMultimodal

参数形状和 `generateText` 一样，区别是消息的 `content` 可以是数组，图文混排：

```typescript
const desc = await vision.generateMultimodal({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图里是什么？一句话回答" },
        { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
      ],
    },
  ],
});
```

图片放进 `image_url.url`，`detail` 可以选 `auto` / `low` / `high` 控制识别精度。多张图就多放几个 `image_url` 项。

::: tip
用哪个实例看图有讲究：用户可能把 vision 角色绑到一个支持视觉的模型上。照上面的退化逻辑取 `vision` 实例，别拿 `main` 硬看。
:::

## 让模型自己调工具

AI 服务里最有意思的部分。流程是：定义工具 → 打包成技能注册 → 用 `generateWithTools` 对话，模型觉得需要就自己调。

写一个查天气的插件，完整代码：

```typescript
import { definePlugin, getService, Services } from "mioku";
import type { AITool, AISkill } from "mioku";

const weatherTool: AITool = {
  name: "query_weather",
  description: "查询指定城市的当前天气，用户问到天气相关问题时调用",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名，比如：上海" },
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

跑起来之后，用户发「上海天气怎么样」，模型会自己决定调 `query_weather`，拿到结果再组织成回答。你不用写任何「判断意图 → 调接口 → 拼回复」的胶水逻辑。

几个值得展开的点：

**工具的四个字段。** `name` 和 `description` 是给模型看的——description 写得越具体、越说明「什么情况下该调我」，模型判断得越准。`parameters` 是 JSON Schema，描述入参；`handler` 是你的实现，`args` 就是模型给的参数，记得在里面做好校验，别信模型传的一定对。

**工具必须包在技能里注册。** 服务上没有「注册散装工具」的入口，`registerSkill(skill)` 一次注册一个技能，技能里的所有工具跟着进去。同名技能会被覆盖，日志里有警告。`AITool` 的完整定义见[类型参考](/reference/api/interfaces/AITool)。

**`generateWithTools` 自动带上所有已注册技能的工具。** 它内部会收集所有技能的工具（工具名会被加上 `技能名.` 前缀，比如 `weather.query_weather`），交给模型挑选；模型调用后框架自动执行 handler、把结果喂回去，循环直到模型给出最终回答。返回值长这样：

| 字段             | 说明                        |
|----------------|---------------------------|
| `content`      | 最终回答文本                    |
| `iterations`   | 实际跑了几轮工具循环                |
| `allToolCalls` | 这轮对话里发生过的所有工具调用（名称、参数、结果） |

**handler 里想发消息、拿插件上下文？** handler 的第二个参数是调用现场。聊天插件调用工具时会带上 `ctx` 和 `event`，你的工具可以直接在里面回消息、取服务——help 插件的 `send_help_image` 工具就是这么把生成的帮助图片发出去的。它是可选的，别处调用可能不传，用之前判一下：

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

`AISkill` 的 `permission` 字段声明这个技能开放给哪类用户：

| 值        | 谁                     |
|----------|-----------------------|
| `member` | 任意成员（默认值，写了非法值也会回退到它） |
| `admin`  | bot 主人或管理员            |
| `master` | 仅 bot 主人              |
| `owner`  | `master` 的旧写法，等价      |

权限的具体拦截发生在调用方——比如 chat 插件会按触发用户的角色过滤技能，角色等级不够的技能根本不会进到模型眼里。AI 服务本身只负责存取，所以就算你的工具被高权限技能包着，`handler` 里该做的参数校验一样不能省。

## 聊天运行时：ChatRuntime

chat 插件（`mioku-plugin-chat`）把一套「让 AI 说话」的能力注册到了 AI 服务上，叫 **ChatRuntime**。别的插件可以借它：让 AI 用自然语言发一条通知，或者按指定格式收集结构化信息——不用自己拼 prompt、开工具循环。插件里这样拿：

```typescript
const aiService = getService(ctx, Services.AI);
const chatRuntime = aiService?.getChatRuntime();
```

chat 插件是系统插件默认就装，但用户可能禁用，`getChatRuntime()` 返回 `undefined` 时记得判空。

### generateNotice：让 AI 发一条自然的通知

场景：你的插件想提醒群成员一件事，但不想用干巴巴的机器人腔。传一个 `event`（或 `selfId` + `groupId`）和 `instruction`，chat 插件会让 AI 结合上下文组织语言发出去：

```typescript
const chatRuntime = aiService?.getChatRuntime();
if (chatRuntime) {
  await chatRuntime.generateNotice({
    event,                // 复用当前消息事件的上下文（群号、用户）
    instruction: "提醒大家明天下午三点团建，楼下集合",
    send: true,           // 生成后直接发送
    promptInjections: [   // 可选：附加指令，约束 AI 的语气
      { title: "Notice", content: "用轻松的语气，不要提到任何插件或命令。" },
    ],
  });
}
```

常见参数：

| 参数                                               | 说明                  |
|--------------------------------------------------|---------------------|
| `event` / `selfId`+`groupId` / `selfId`+`userId` | 通知发到哪：传事件、群目标或私聊目标  |
| `instruction`                                    | 要表达的内容，必填           |
| `send`                                           | 生成后是否直接发送，默认 `true` |
| `targetMessage`                                  | 可选，喂给 AI 的额外上下文     |
| `promptInjections`                               | 可选，附加提示词，约束语气和行为    |

返回值是 `ChatRuntimeResult`（生成的消息、工具调用记录等），`send: true` 时已经发出去了，一般用不到返回值。

### requestInformation：让 AI 按格式收集信息

想让 AI 在对话里收集结构化信息（比如问出用户的生日、城市、星座），传一个 `task` 和 JSON Schema 的 `schema`，AI 会通过工具把收集到的数据提交回来：

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

`collectedInfo.data` 是 AI 提交的数据对象，`isComplete` 标记是否收集完整，`confidence` 是置信度，`notes` 是 AI 的补充说明。收集不全时 `data` 可能是 `undefined`，用之前判一下。

完整定义见[类型参考](/reference/api/interfaces/ChatRuntime)和[ChatRuntimeResult](/reference/api/interfaces/ChatRuntimeResult)。

## 需要精细控制时：complete()

`generateText` 和 `generateWithTools` 其实都是 `complete()` 的快捷方式。要流式输出、手动接管工具循环这类需求，直接用它：

```typescript
const res = await instance.complete({
  messages: [{ role: "user", content: "给我讲个冷笑话" }],
  stream: true,
  onTextDelta: (delta) => {
    process.stdout.write(delta); // 流式输出的每个增量片段
  },
});

res.content;   // 完整文本
res.reasoning; // 推理模型的思考过程（有的话）
res.toolCalls; // 模型请求的工具调用
```

`CompleteOptions` 里值得知道的选项：

| 选项                                     | 说明                       |
|----------------------------------------|--------------------------|
| `messages`                             | 必填，消息数组                  |
| `stream` / `onTextDelta`               | 流式输出，每个增量文本都会进回调         |
| `executableTools`                      | 会话内可执行的工具，传了之后框架自动进入工具循环 |
| `executableToolsProvider`              | 同上，但每轮循环时现取，适合工具集动态变化的场景 |
| `maxIterations`                        | 工具循环的最大轮数，防模型无限调工具       |
| `model` / `temperature` / `max_tokens` | 同 `generateText`         |

返回的 `CompleteResponse` 除了上面示例里的字段，还有 `iterations`（循环轮数）和 `allToolCalls`（完整调用记录），定义见[类型参考](/reference/api/interfaces/CompleteResponse)。

## 思考等级

推理模型可以调思考力度，`AIThinkingLevel` 一共六档：`off` / `low` / `medium` / `high` / `xhigh` / `max`。Gemini 协议只支持到 `high`，再高的值会被忽略。设置走 `aiService.setModelThinkingLevel?.(modelFullId, level)`，跟插件关系不大，一般让用户自己在 WebUI 里调。

## 下一步

- [插件间通信](/developer/communicate) —— 怎么拿到 AI 服务这个实例
- [AIService 类型参考](/reference/api/interfaces/AIService)
- [AIInstance 类型参考](/reference/api/interfaces/AIInstance)
- [AITool 类型参考](/reference/api/interfaces/AITool)
