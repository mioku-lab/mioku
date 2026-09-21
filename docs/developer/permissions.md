# 权限与访问控制

「这条指令谁能用」由命令管理器统一处理：[`ctx.command()` 的 `permission`](/developer/commands) 字段在派发时直接执行，配置文件再提供按插件、群、用户的细粒度覆盖。

## 角色

框架配置里有两份名单，写在项目 package.json 的 `mioku` 字段（见[配置文件](/guide/configuration)）：

| 名单 | 角色 |
| --- | --- |
| `owners` | 主人（master），最高权限 |
| `admins` | 管理员（admin），仅次于主人 |
| （其他人） | 普通成员（member） |

除了配置名单，群聊场景下还会识别发送者在群里的身份：

| 来源 | 角色 |
| --- | --- |
| `mioku.owners` | master |
| 当前群群主 | owner（仅限所在群生效） |
| `mioku.admins` 或当前群管理员 | admin |

这些角色映射到命令的 `permission` 字段：

| 值 | 谁能触发 |
| --- | --- |
| `member` | 所有人 |
| `admin` | bot 主人、配置管理员、当前群群主或群管理员 |
| `owner` | bot 主人或当前群群主 |
| `master` | 仅 bot 主人 |

推荐做法：把角色写在 `ctx.command()` 上，让命令管理器执行：

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

权限不满足时命令会被悄悄丢弃，handler 不会被调用，也不向用户报错（避免暴露命令存在）。需要主动提示时，可以在 handler 里调用 `ctx.isMaster(event)` / `ctx.isOwner(event)` 等判断。

## ctx 上的判断方法

`ctx.isMaster(event)` / `ctx.isOwner(event)` / `ctx.isAdmin(event)` 等方法与 `permission` 语义对齐，用于「非命令」分支（戳一戳回调、关键词命中后的二次判断、CD 豁免等）：

| 方法 | 返回 true 的条件 | 等价 `permission` |
| --- | --- | --- |
| `ctx.isMaster(event)` | 发送者在 `mioku.owners` 里（仅主人） | `master` |
| `ctx.isOwner(event)` | 主人或当前群群主 | `owner` |
| `ctx.isAdmin(event)` | 主人、配置管理员、当前群群主或群管理员 | `admin` |
| `ctx.isOwnerOrAdmin(event)` | 同 `isAdmin` | `admin` |
| `ctx.hasRight(event)` | 同 `isAdmin` | `admin` |

需要更细粒度判断时，可以用 `ctx.isEventGroupOwner(event)` / `ctx.isEventGroupAdmin(event)`（仅看当前群身份）、`ctx.isEventAdminConfigOnly(event)`（仅看 `mioku.admins`）、`ctx.toUserId(event)`（把事件压平为用户 id）。

框架会从事件里提取发送者 id（裸 id、`user_id`、`sender.user_id` 几种形态都认），再和名单比对，不同适配器的事件结构差异被它挡掉了。

## 访问控制：access-control

角色之外还有一层更细的控制：某个群就是不想让 music 插件响应，或者某条指令只想在特定人群开放。这类规则放在 `config/core/access-control.json`，core 插件第一次启动时会自动创建这个文件：

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

结构解读：

| 字段 | 说明 |
| --- | --- |
| `version` | 固定为 1 |
| `global` | 全局生效的规则 |
| `groups` | 按群配置，键是群号字符串 |
| `users` | 按用户配置，键是 QQ 号字符串 |

每个作用域里都是两级：`plugins` 按「插件名 → 规则」管整个插件，`commands` 按「插件名 → 命令 id → 规则」管具体命令。规则只有一个字段 `action`，取 `allow`（放行）或 `block`（拦截）。没配规则的命令一律放行——这份文件初始就是空的，默认行为是全部可用。

命令 id 是 `ctx.command()` 注册时的 `id`（默认等于 `name`），例如 `weather`、`帮助菜单`。这份文件可以手工编辑，也可以在 WebUI 的访问控制页面里改，效果一样。

优先级：**用户 > 群 > 全局**，同一作用域内 `commands` 优先于 `plugins`。bot 主人、管理员、群主、群管理员绕过访问规则，但不会绕过命令自身的 `permission` 角色限制。

## 内置 core 命令的权限

core 插件的系统命令默认只有主人能触发：`.plugin`、`.settings`、`.install`、`.uninstall`、`.restart`、`.log`、`.update`、`.exit` 这些。例外是 `.status`（`.状态`）和 `.adapter`（`.适配器`），默认所有人可看；把 `status_permission` 配成 `"admin-only"` 后就需要主人或管理员。

`.settings` 值得一提：`.settings add-owner / remove-owner / add-admin / remove-admin` 会直接改写 package.json 里的 owners/admins 名单——它能「授权」别人，所以必须锁在主人手里。顺带一提，`.settings remove-owner` 不允许删第一主人。

core 命令同样能被 access-control 按 id 单独拦截，`.plugin`、`settings`、`install`、`update` 等命令都已被命令管理器登记。

## 参考

- [命令管理器](/developer/commands) —— `ctx.command()` 的完整字段、handler 入参、优先级与冲突
- [事件处理](/developer/events) —— `ctx.handle()` 的路由
- [类型参考 - AccessControlConfig](/reference/api/interfaces/AccessControlConfig)
- [类型参考 - CommandRole](/reference/api/type-aliases/CommandRole)
- [配置文件](/guide/configuration) —— owners / admins 在哪配
