---
title: 操作 Bot
description: 通过 bot 对象发送消息、管理群、查询资料与处理多账号。
---

# 操作 Bot

插件处理消息之外的另一半工作，是让机器人主动做事：发送消息、管理群、查询资料。这些操作都挂在 bot 对象上，bot 把平台能力收敛成了一组统一方法。

## 获取 bot

有三种途径。

```typescript
// 事件自带的 bot
ctx.handle("message", async (event) => {
  await event.bot.sendGroupMsg(event.group_id, "收到");
});

ctx.bot;              // 第一个连接的 bot
ctx.pickBot("10001"); // 按 bot_id 取指定 bot
ctx.bots;             // 全部已连接的 bot
```

多适配器同时在线时，`ctx.bots` 中混合着各个平台的 bot，可以用 `bot.adapter` 区分。想查看已加载的适配器，包括当前没有 bot 连上的适配器，使用 `ctx.adapters` 和 `ctx.getAdapter(name)`。

## 消息

```typescript
// 发送到群或私聊
await bot.sendGroupMsg("group_id", "大家好");
await bot.sendPrivateMsg("user_id", "私聊内容");

// 发送到任意目标
await bot.sendMessage({ type: "group", group_id: "123" }, "内容");

// 合并转发
await bot.sendForward(
  { type: "group", group_id: "123" },
  [
    { user_id: "10001", nickname: "初音", content: "第一句" },
    { user_id: "10002", nickname: "镜音", content: "第二句" },
  ],
);

// 撤回与查询
await bot.recallMessage("message_id");
const msg = await bot.getMessage("message_id");

// 拉取历史
const history = await bot.getHistory({ type: "group", group_id: "123" }, undefined, 20);
```

## 群管理

```typescript
const group = await bot.getGroupInfo("group_id");
const groups = await bot.getGroupList();

// 成员
const members = await bot.getGroupMembers("group_id");
const member = await bot.getMemberInfo("group_id", "user_id");

// 管理操作
await bot.banMember("group_id", "user_id", 600);        // 禁言 10 分钟，单位为秒
await bot.banMember("group_id", "user_id", 0);          // 解除禁言
await bot.kickMember("group_id", "user_id");            // 踢出
await bot.setMemberCard("group_id", "user_id", "新名片");
await bot.setMemberAdmin("group_id", "user_id", true);  // 设为管理员
await bot.pokeMember("group_id", "user_id");            // 戳一戳
await bot.setGroupName("group_id", "新群名");
await bot.setGroupWholeBan("group_id", true);           // 全员禁言
await bot.leaveGroup("group_id");                       // 退群
```

::: warning 权限要求
这些操作需要机器人本身在群中拥有对应权限，例如管理员或群主。没有权限时平台会拒绝操作。调用前可以先通过 `getMemberInfo` 查看自己的角色。
:::

## 好友与资料

```typescript
const friend = await bot.getFriendInfo("user_id");
const friends = await bot.getFriendList();
await bot.deleteFriend("user_id");

await bot.setProfile({ nickname: "Miku" });  // 修改资料
await bot.setAvatar("/tmp/avatar.png");      // 更换头像
```

## 状态

```typescript
const status = await bot.getStatus();
// 内容包含在线状态与收发消息数，具体字段由适配器实现决定
```

## 平台特有类型

统一接口覆盖大部分场景。`sendLike`、`getCookie`、`pickGroup` 这类平台独有的功能需要拿到平台特有类型。有三种方式，按推荐顺序排列。

**1. 路由推断**

监听事件时把适配器名写进路由，`event.bot` 自动就是该平台的类型。

```typescript
ctx.handle("icqq:message", async (event) => {
  await event.bot.sendLike(event.user_id);  // IcqqBot 的方法
});
```

**2. 判断 adapter 字段**

`ctx.bot` 和 `ctx.bots` 是联合类型。安装了哪些适配器，就联合哪些 bot 类型，例如 `OneBot | IcqqBot | StdinBot`。每个 bot 的 `adapter` 字段是字面量，用 `if` 判断它就能让 TypeScript 自动收窄，不需要断言。

```typescript
for (const bot of ctx.bots) {
  if (bot.adapter === "icqq") {
    await bot.sendLike(bot.bot_id);      // IcqqBot
  } else if (bot.adapter === "onebotv11") {
    await bot.getCookie("qun.qq.com");   // OneBot
  }
}
```

**3. 显式泛型或断言**

`ctx.pickBot` 和 `ctx.getAdapter` 不会按字符串推断类型，需要传入泛型或使用 `as`。

```typescript
const bot = ctx.pickBot<OneBot>("10001");     // 泛型指定

import type { OneBot } from "mioku-adapter-onebotv11";
const onebot = (ctx.bot as OneBot | undefined)?.getCookie("qun.qq.com");
```

`bot.as<T>()` 也用于这个目的，例如 `bot.as<OneBot>()`。前面两种方式都无法覆盖时才使用断言，例如 bot 来自某个服务，而不是事件或 `ctx.bots`。

::: tip 类型名的位置
适配器 bot 的类型名定义在它的 `src/bot.ts` 中，例如 `OneBot`、`IcqqBot` 和 `StdinBot`，都是 `BotBase` 的子类型。安装适配器包后可以用 `import type { OneBot } from "mioku-adapter-onebotv11"` 导入。
:::

## 平台原生 API

统一接口无法覆盖平台特有功能时，可以直接调用平台 API。

```typescript
const result = await bot.sendApi<T>("set_group_ban", {
  group_id: 123,
  user_id: 456,
  duration: 60,
});
```

`sendApi` 是最通用的方式，任何平台动作都能发送。它的参数类型比较宽松，是 `Record<string, unknown>` 或展开参数，没有编辑器提示。能拿到平台特有类型时，应优先使用类型化方法。

## 多账号

`ctx.bots` 是全部在线 bot，批量操作时遍历即可。

```typescript
for (const bot of ctx.bots) {
  await bot.sendGroupMsg(group_id, "全体注意");
}
```

`ctx.bot` 只取第一个。多账号时应优先使用 `event.bot` 或 `pickBot` 明确指定。

## 下一步

- [定时任务与生命周期](/developer/cron-lifecycle)：在 bot 上线后执行逻辑
- [配置与数据存储](/developer/config-data)：保存插件数据
- [权限与访问控制](/developer/permissions)：判断操作者身份
