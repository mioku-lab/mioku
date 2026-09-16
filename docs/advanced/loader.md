# 包发现与加载

框架怎么知道项目里有哪些插件、哪些适配器？怎么决定加载顺序？这一章讲加载器（loader）的工作方式。

## 发现：按前缀找依赖

框架读取项目 `package.json` 的 `dependencies`（直接依赖），按前缀分类：

| 前缀 | 归类 |
| --- | --- |
| `mioku-plugin-*` | 插件候选 |
| `mioku-adapter-*` | 适配器候选 |
| `mioku-service-*` | 服务（由服务管理器扫描，见[开发服务](/developer/service-dev)） |

插件名 = 包名去掉前缀，比如 `mioku-plugin-60s` → `60s`。

::: warning 只查直接依赖
发现逻辑只看项目 `package.json` 的 `dependencies`。插件装在 `devDependencies` 或间接依赖里都不会被发现。
:::

## 校验：apiVersion 与 name

发现候选后，加载前有两道校验：

1. **name 一致**：包名去掉前缀后的短名，必须等于插件 `definePlugin` 里的 `name`。不一致报 `Plugin canonical ID mismatch`。
2. **apiVersion 一致**：适配器包的 apiVersion 必须等于框架要求的版本（目前是 1）。适配器升级协议不向后兼容时，框架会 bump 这个值，老适配器直接拒绝加载而不是运行时报错。

插件还有第三道校验：manifest 合法性。`package.json` 里 `mioku` 字段只认 `services` 一个键，另兼容 `help` / `accessHooks` 两个旧键，未知字段忽略并告警（详见[发布插件](/developer/publish)）。

## 加载：jiti 动态导入

插件入口通过 [jiti](https://github.com/unjs/jiti) 动态导入——这意味着**插件源码可以直接是 TypeScript**，不需要先编译。入口解析顺序：

1. `mioku` 字段里显式指定的 entry（如果有）
2. `main` / `module` / `exports["."]`
3. 兜底尝试 `dist/index.mjs`、`dist/index.js`、`index.mjs`、`index.js`

所以发布插件时 `main` 指到 `index.ts` 是合法的，运行时现编。生产环境更稳妥的做法是构建成 JS（见[发布插件](/developer/publish)）。

## 插件加载顺序

`mioku.plugins` 里的每个插件名，会先在本地 `plugins/` 目录找，找不到再去依赖里找。

加载按 `priority` 分组：

1. 内置插件（core，priority `-Infinity`）最先
2. 用户插件按 priority 从小到大分组，同组 `Promise.allSettled` 并行加载

```text
>>> 加载用户插件: 优先级 -Infinity (core)，优先级 10 (foo)，优先级 100 (bar, baz)
```

并行加载意味着同 priority 的插件 `setup` 顺序不保证。插件之间有先后依赖时，用 priority 拉开层次。

## 运行时插件管理

内置 core 插件暴露了一组运行时管理指令：

```text
.plugin list                # 已启用插件
.plugin enable <name>       # 启用（会同时写入 mioku.plugins）
.plugin disable <name>      # 禁用
.plugin reload <name>       # 重载
```