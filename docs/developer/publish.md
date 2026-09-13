# 发布插件

插件在本地 `plugins/` 目录里写好了，想分享给别人，就发布成 npm 包。

## 发布前检查清单

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

| 字段                 | 要求                                                           |
|--------------------|--------------------------------------------------------------|
| `name`             | 必须是 `mioku-plugin-<短名>` 格式，短名要和你 `definePlugin` 里的 `name` 一致 |
| `main`             | 指向插件入口，一般就是 `index.ts`（框架用 jiti 加载，直接发 TS 没问题）               |
| `type`             | `"module"`                                                   |
| `keywords`         | **必须包含 `"mioku"`**，市场搜索全靠它过滤，漏了就搜不到                          |
| `peerDependencies` | 声明 `mioku: "^1.0.0"`，别把框架写成 `dependencies` 装进自己包里            |

## manifest：mioku 字段

`package.json` 的 `mioku` 字段是插件对框架的声明，框架认三个键：`services`、`help`、`accessHooks`。**新插件应把命令注册写在插件入口里**——用 `ctx.command()` 一次声明命令名、别名、描述、权限、优先级，框架会自动收录到帮助和访问控制目录里。manifest 中的 `help` 与 `accessHooks` 仅在旧插件兼容时使用，写别的键没用——会被忽略并打一条「含未知字段」的警告。

只声明 `services` 的最小 manifest：

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

```ts
import { definePlugin } from "mioku";

export default definePlugin({
  name: "weather",
  version: "1.0.0",
  description: "查天气插件",
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

### services：声明依赖

| 键 | 类型 | 作用 |
| --- | --- | --- |
| `services` | 字符串数组 | 声明依赖的服务短名，用户安装时 CLI 会自动补装缺的服务包 |

如果 `services` 不是数组会被整个丢弃，启动日志会有提示。

## 发布到 npm

检查完就可以发了：

```bash
npm publish
# 或者
bun publish
```

版本号按语义化版本来：修 bug 升 patch（1.0.1），加功能升 minor（1.1.0），改了用法、别人必须跟着改代码的升 major（2.0.0）。发完不用通知谁，用户那边 `mioku update` 就能更到。

## 下一步

- [第一个插件](/developer/first-plugin) —— 还没写过插件的话，从这里开始
- [命令管理器](/developer/commands) —— `ctx.command()` 的全部字段
- [插件市场](/guide/market) —— 用户是怎么安装、更新你的插件的
- [PluginPackageConfig 类型参考](/reference/api/interfaces/PluginPackageConfig)
