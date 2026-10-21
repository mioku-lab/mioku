---
title: 能力系统
description: Mioku 能力的定义、注册、调用与版本化。
---

# 能力系统

插件使用的 `bot.sendGroupMsg` 和 `bot.banMember` 这些方法不是框架写死的，它们都是能力 Capability。适配器声明这个平台可以执行哪些操作，框架把声明绑定成 bot 的方法，插件只负责调用。

## 能力的组成

一个能力是一个带类型的契约，由三部分组成。

- **名字**：例如 `message.send` 和 `member.ban`。
- **版本**：数字，默认是 1。
- **输入输出类型**：请求的结构和返回的结构。

定义方式如下。

```typescript
import { defineCapability } from "mioku";

// 请求：发送目标与内容
interface SendRequest {
  target: MessageTarget;
  message: MessageInput;
}

// 返回：消息 id 与发送时间
interface SendResult {
  message_id?: string;
  sent_at?: number;
}

export const messageSend = defineCapability<SendRequest, SendResult>("message.send", 1);
```

`defineCapability<I, O>(name, version)` 返回的能力对象带有一个私有 token。同名同版本的能力全局唯一，可以防止两个适配器互相覆盖同一个实现。

## 内置能力

框架在 `mioku` 顶层导出全部内置能力，源码位于 `packages/mioku/src/capabilities/`，按域分组。

| 域 | 能力 | 对应的 bot 方法 |
| --- | --- | --- |
| 消息 | `messageSend`、`messageRecall`、`messageGet`、`messageGetForward`、`forwardSend` | `sendMessage`、`recallMessage`、`getMessage`、`getForwardMessage`、`sendForward` |
| 成员 | `memberBan`、`memberKick`、`memberSetCard`、`memberSetAdmin`、`memberSetTitle`、`memberPoke`、`memberGetInfo` | `banMember`、`kickMember`、`setMemberCard`、`setMemberAdmin`、`setMemberTitle`、`pokeMember`、`getMemberInfo` |
| 群 | `groupGetInfo`、`groupGetList`、`groupGetMembers`、`groupLeave`、`groupSetName`、`groupSetWholeBan`、`groupSetPortrait` | `getGroupInfo`、`getGroupList`、`getGroupMembers`、`leaveGroup`、`setGroupName`、`setGroupWholeBan`、`setGroupPortrait` |
| 好友 | `friendGetInfo`、`friendGetList`、`friendDelete` | `getFriendInfo`、`getFriendList`、`deleteFriend` |
| 资料 | `profileSet`、`avatarSet` | `setProfile`、`setAvatar` |
| 会话 | `conversationGetHistory` | `getHistory` |
| 系统 | `botStatus` | `getStatus` |

每个能力的请求与返回类型也在顶层导出，例如 `MessageSendRequest` 和 `MemberBanRequest`。适配器实现时按类型填写即可。

## 注册实现

适配器在 `start` 中通过 `AdapterContext.registerCapability` 注册能力，必须指定作用目标。

```typescript
context.registerCapability(
  messageSend,
  { adapter: "onebotv11", bot_id: "10001" },
  async (req) => platformSend(req.target, req.message),
);
```

目标 `CapabilityTarget` 有三个定位维度。

| 字段 | 作用 |
| --- | --- |
| `adapter` | 适配器名，必填 |
| `bot_id` | 具体 bot，可选。不填表示适配器级实现 |
| `resource_id` | 更细的资源，可选，例如某个网关 |

因此同一个能力在不同 bot 上可以有不同实现，多账号时每个 bot 各注册一份。注册返回取消函数，在 `stop` 时反注册。

实现时需要注意：handler 收到的输入就是插件传入的请求对象。适配器负责把它翻译成平台指令，再把结果翻译成契约中的返回类型。能力只承诺输入输出，不承诺平台实现，插件因此可以在多平台之间无差别运行。

## 调用能力

插件拿到的 bot 已经绑定了全部已注册能力，直接调用方法即可。

```typescript
await event.bot.banMember("group_id", "user_id", 600);
await event.bot.getGroupList();
```

这些方法由 `bindCapabilities` 在 bot 注册时生成。它遍历能力注册表，把每个能力绑定成同名方法，例如 `message.send` 对应 `sendMessage`。插件不需要直接接触注册表。

框架内置的 `bindCapabilities` 只绑定内置方法。自定义能力没有对应方法，插件需要通过注册表调用，或者让 bot 转发。

```typescript
// 直接调用注册表
await ctx.capabilities.invoke(
  { adapter: "my", bot_id: bot.bot_id },
  myCustomCapability,
  { keyword: "hello" },
);

// 让 bot 转发
await bot.sendApi("my.custom_action", { keyword: "hello" });
```

## 自定义能力

内置能力不够用时可以自行定义。完整链路是适配器定义能力、注册实现、插件调用。

**1. 在适配器包内定义能力并导出。**

```typescript
// adapter/src/capabilities.ts
import { defineCapability } from "mioku";

export interface SpeakRequest {
  text: string;
  voice?: "xiaoai" | "yunxi";
}

export const ttsSpeak = defineCapability<SpeakRequest, { task_id: string }>("my.tts_speak", 1);
```

**2. 适配器注册实现。**

```typescript
context.registerCapability(
  ttsSpeak,
  { adapter: "my", bot_id: BOT_ID },
  async (req) => submitTtsTask(req.text, req.voice),
);
```

**3. 插件调用。** 做法与 `defineService` 相同，把能力引用定义在公共位置。

```typescript
import { ttsSpeak } from "mioku-adapter-my";

// 插件中找到目标 bot 后调用
const bot = ctx.pickBot("10001");
if (bot && ctx.capabilities.supports({ adapter: "my", bot_id: bot.bot_id }, ttsSpeak)) {
  const result = await ctx.capabilities.invoke(
    { adapter: "my", bot_id: bot.bot_id },
    ttsSpeak,
    { text: "你好" },
  );
}
```

## 错误与预检

- 目标上没有注册某个能力时调用，会抛出 `UnsupportedCapabilityError`，消息中带有能力名。
- 调用前可以用 `registry.supports(target, capability)` 预检，返回布尔值。插件需要优雅降级时依赖它，例如平台不支持语音合成时改发文字。
- 同名同版本的能力对同一目标重复注册会直接抛错，用于防止两个适配器抢占同一个实现。

## 版本化

`defineCapability(name, version)` 的 version 默认是 1。同名但版本不同的能力视为不同能力，token 不同，互不干扰。

- 适配器升级能力实现但契约不变时，版本保持不变，旧插件可以继续使用。
- 契约发生变化时，例如请求或返回结构被修改，需要递增版本。新旧实现可以并存，由插件显式选择。

## 下一步

- [开发适配器](/developer/adapter-dev)：能力在哪里注册，如何与 bot 配合
- [defineCapability 类型参考](/reference/api/functions/defineCapability)：定义的完整签名
- [CapabilityRegistry 类型参考](/reference/api/classes/CapabilityRegistry)：注册表的完整接口
