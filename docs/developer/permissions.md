---
title: 权限与访问控制
description: Mioku 的角色体系、命令权限与 access-control 访问规则。
---

# 权限与访问控制

一条命令由谁触发，由命令管理器统一处理。命令的 `permission` 字段在派发时执行，配置文件再提供按插件、按群和按用户的细粒度覆盖。

## 角色

框架配置中有两份名单，写在项目 `package.json` 的 `mioku` 字段中，见[配置文件](/guide/configuration)。

| 名单 | 角色 |
| --- | --- |
| `owners` | 主人 master，最高权限 |
| `admins` | 管理员 admin，权限仅次于主人 |
| 其他用户 | 普通成员 member |

群聊场景下还会识别发送者在群里的身份。

| 来源 | 角色 |
| --- | --- |
| `mioku.owners` | master |
| 当前群群主 | owner，仅在所在群生效 |
| `mioku.admins` 或当前群管理员 | admin |

这些角色映射到命令的 `permission` 字段。

| 值 | 谁能触发 |
| --- | --- |
| `member` | 所有人 |
| `admin` | bot 主人、配置管理员、当前群群主或群管理员 |
| `owner` | bot 主人或当前群群主 |
| `master` | 仅 bot 主人 |

推荐做法是把角色写在 `ctx.command()` 上，由命令管理器执行。

```typescript
ctx.command({
  name: "weather",
  permission: "member",
  handler: async ({ event, args }) => {
    await event.reply(`查询 ${args.join(" ") || "当前城市"}`);
  },
});

ctx.command({
  name: "stats",
  permission: "admin", // 主人、管理员、群主或群管理员
  handler: async ({ event }) => {
    await event.reply("系统统计信息");
  },
});

ctx.command({
  name: "shutdown",
  permission: "master", // 仅主人
  handler: async () => { /* ... */ },
});
```

权限不满足时命令会被静默丢弃，handler 不会被调用，也不向用户报错，以免暴露命令的存在。需要主动提示时，可以在 handler 中调用 `ctx.isMaster(event)` 等方法判断。

## 判断方法

`ctx.isMaster(event)`、`ctx.isOwner(event)` 和 `ctx.isAdmin(event)` 与 `permission` 语义对齐，用于非命令分支，例如戳一戳回调、关键词命中后的二次判断和 CD 豁免。

| 方法 | 返回 true 的条件 | 等价的 `permission` |
| --- | --- | --- |
| `ctx.isMaster(event)` | 发送者在 `mioku.owners` 中 | `master` |
| `ctx.isOwner(event)` | 主人或当前群群主 | `owner` |
| `ctx.isAdmin(event)` | 主人、配置管理员、当前群群主或群管理员 | `admin` |
| `ctx.isOwnerOrAdmin(event)` | 同 `ctx.isAdmin` | `admin` |
| `ctx.hasRight(event)` | 同 `ctx.isAdmin` | `admin` |

需要更细的判断时使用以下方法。

- `ctx.isEventGroupOwner(event)`：只看当前群群主身份。
- `ctx.isEventGroupAdmin(event)`：只看当前群管理员身份。
- `ctx.isEventAdminConfigOnly(event)`：只看 `mioku.admins`。
- `ctx.toUserId(event)`：把事件压平为用户 id。

框架会从事件中提取发送者 id。裸 id、`user_id` 和 `sender.user_id` 几种形态都能识别，然后与名单比对。不同适配器的事件结构差异由框架处理。

## 访问控制

角色之外还有一层更细的控制。例如某个群不希望 music 插件响应，或者某条指令只对特定人群开放。这类规则放在 `config/core/access-control.json`，core 插件第一次启动时会自动创建该文件。

```json
{
  "version": 1,
  "global": {
    "plugins": {
      "music": { "action": "block" }
    },
    "commands": {}
  },
  "groups": {
    "123456789": {
      "plugins": {
        "impact": { "action": "block" }
      },
      "commands": {
        "weather": {
          "上海天气": { "action": "allow" }
        }
      }
    }
  },
  "users": {
    "10001": {
      "commands": {
        "weather": {
          "查询": { "action": "block" }
        }
      }
    }
  }
}
```

文件结构如下。

| 字段 | 说明 |
| --- | --- |
| `version` | 固定为 1 |
| `global` | 全局生效的规则 |
| `groups` | 按群配置，键是群号字符串 |
| `users` | 按用户配置，键是 QQ 号字符串 |

每个作用域中有两级配置。`plugins` 按插件名匹配整个插件，`commands` 按插件名和命令 id 匹配具体命令。规则只有一个 `action` 字段，取值为 `allow` 或 `block`。没有配置规则的命令一律放行。这份文件初始为空，默认行为是全部可用。

命令 id 是 `ctx.command()` 注册时的 `id`，默认等于 `name`，例如 `weather` 和 `帮助菜单`。文件可以手工编辑，也可以在 WebUI 的访问控制页面中修改，效果相同。

优先级是用户高于群，群高于全局。同一作用域中 `commands` 优先于 `plugins`。bot 主人、管理员、群主和群管理员绕过访问规则，但不会绕过命令自身的 `permission` 角色限制。

## 内置 core 命令的权限

core 插件的系统命令默认只有主人能触发，包括 `.plugin`、`.settings`、`.install`、`.uninstall`、`.restart`、`.log`、`.update` 和 `.exit`。`.status` 与 `.adapter` 是例外，中文别名是 `.状态` 和 `.适配器`，默认所有人可查看。把 `status_permission` 配成 `"admin-only"` 后，这两个命令需要主人或管理员权限。

`.settings` 需要单独说明。`.settings add-owner`、`remove-owner`、`add-admin` 和 `remove-admin` 会直接改写 `package.json` 中的 owners 与 admins 名单。它能授权其他人，因此必须限制在主人手中。`.settings remove-owner` 不允许删除第一主人。

core 命令同样可以被访问控制按 id 单独拦截。`.plugin`、`settings`、`install` 和 `update` 等命令都已被命令管理器登记。

## 下一步

- [命令管理器](/developer/commands)：`permission` 字段与命令注册
- [事件处理](/developer/events)：在事件监听中判断身份
- [配置文件](/guide/configuration)：owners 与 admins 的配置位置
