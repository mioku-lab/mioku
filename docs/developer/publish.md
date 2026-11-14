---
title: 发布插件
description: 把本地插件发布成 npm 包，包含 package.json 清单与发布流程。
---

# 发布插件

插件在本地 `plugins/` 目录中完成开发后，可以发布成 npm 包分享给别人。

## 发布前检查

```json
{
  "name": "mioku-plugin-weather",
  "version": "1.0.0",
  "description": "查天气插件",
  "main": "index.ts",
  "type": "module",
  "keywords": ["mioku"],
  "peerDependencies": {
    "mioku": "^1.0.0"
  }
}
```

| 字段 | 要求 |
| --- | --- |
| `name` | 必须是 `mioku-plugin-<短名>` 格式，短名要与 `definePlugin` 中的 `name` 一致 |
| `main` | 指向插件入口，一般是 `index.ts`。框架使用 jiti 加载，可以直接发布 TypeScript |
| `type` | 固定为 `"module"` |
| `keywords` | 必须包含 `"mioku"`，市场搜索依赖它过滤，缺失会导致搜不到 |
| `peerDependencies` | 声明 `mioku: "^1.0.0"`，不要把框架写成 `dependencies` 打进自己的包 |

## mioku 字段

`package.json` 的 `mioku` 字段是插件对框架的声明。框架识别 `services`、`help` 和 `accessHooks` 三个键，其中 `help` 与 `accessHooks` 仅供旧插件兼容。未知键会被忽略，并记录一条含未知字段的警告。

新插件应把命令注册写在插件入口中，用 `ctx.command()` 一次声明命令名、别名、描述、权限和优先级，框架会自动收录到帮助与访问控制目录。

只声明 `services` 的最小 manifest 如下。

```json
{
  "name": "mioku-plugin-weather",
  "version": "1.0.0",
  "description": "查天气插件",
  "main": "index.ts",
  "type": "module",
  "keywords": ["mioku"],
  "mioku": {
    "services": ["ai", "config"]
  },
  "peerDependencies": {
    "mioku": "^1.0.0"
  }
}
```

对应的 `index.ts`：

```typescript
import { definePlugin } from "mioku";

export default definePlugin({
  name: "weather",
  async setup(ctx) {
    ctx.command({
      name: "weather",
      aliases: ["天气"],
      description: "查询城市天气",
      usage: "weather <城市>",
      permission: "member",
      async handler({ event, args }) {
        const city = args.join(" ");
        await event.reply(`查询 ${city || "当前城市"}`);
      },
    });
  },
});
```

### services

| 键 | 类型 | 作用 |
| --- | --- | --- |
| `services` | 字符串数组 | 声明依赖的服务短名，用户安装时 CLI 会自动补装缺少的服务包 |

`services` 不是数组时会被整个丢弃，启动日志中会有提示。

## 发布到 npm

检查完成后即可发布。

```bash
npm publish
# 或者
bun publish
```

版本号按语义化版本规则递增。修复 bug 升 patch，例如 1.0.1。新增功能升 minor，例如 1.1.0。修改用法并要求使用者跟着改代码的升 major，例如 2.0.0。发布后不需要通知，用户执行 `mioku update` 即可更新。

## 下一步

- [第一个插件](/developer/first-plugin)：从最小插件开始
- [命令管理器](/developer/commands)：`ctx.command()` 的全部字段
- [插件市场](/guide/market)：用户如何安装和更新插件
