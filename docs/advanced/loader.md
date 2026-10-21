---
title: 包发现与加载
description: Mioku 如何发现插件与适配器，校验清单，并决定加载顺序。
---

# 包发现与加载

框架如何知道项目中存在哪些插件和适配器，又如何决定加载顺序，由加载器 loader 负责。本章说明它的工作方式。

## 发现依赖

框架读取项目 `package.json` 的 `dependencies`，也就是直接依赖，然后按前缀分类。

| 前缀 | 归类 |
| --- | --- |
| `mioku-plugin-*` | 插件候选 |
| `mioku-adapter-*` | 适配器候选 |
| `mioku-service-*` | 服务，由服务管理器扫描，见[开发服务](/developer/service-dev) |

插件名是包名去掉前缀后的短名。例如 `mioku-plugin-60s` 的插件名是 `60s`。

::: warning 只检查直接依赖
发现逻辑只读取项目 `package.json` 的 `dependencies`。安装在 `devDependencies` 中或作为间接依赖存在的包都不会被发现。
:::

## 校验

发现候选之后，加载之前有两道校验。

1. **name 一致**：包名去掉前缀后的短名，必须等于插件 `definePlugin` 中的 `name`。不一致时报告 `Plugin canonical ID mismatch`。
2. **apiVersion 一致**：适配器包的 apiVersion 必须等于框架要求的版本，当前是 1。适配器升级协议且不向后兼容时，框架会递增这个值，旧适配器会被直接拒绝加载，而不是在运行时出错。

插件还有一道 manifest 校验。`package.json` 的 `mioku` 字段识别 `services`、`help` 和 `accessHooks` 三个键，其中后两个仅供旧插件兼容。未知字段会被忽略并记录警告，详见[发布插件](/developer/publish)。

## jiti 动态导入

插件入口通过 [jiti](https://github.com/unjs/jiti) 动态导入。这意味着插件源码可以直接是 TypeScript，不需要预先编译。入口解析顺序如下。

1. `mioku` 字段中显式指定的 entry，如果存在。
2. `main`、`module` 或 `exports["."]`。
3. 兜底尝试 `dist/index.mjs`、`dist/index.js`、`index.mjs` 和 `index.js`。

因此发布插件时把 `main` 指向 `index.ts` 是合法的，运行时即时编译。生产环境更稳妥的做法是构建成 JavaScript，见[发布插件](/developer/publish)。

## 加载顺序

`mioku.plugins` 中的每个插件名会先在本地 `plugins/` 目录中查找，找不到时再到依赖中查找。

加载按 `priority` 分组。

1. 内置插件最先加载，其中 core 的 priority 是 `-Infinity`。
2. 用户插件按 priority 从小到大分组，同组内使用 `Promise.allSettled` 并行加载。

```text
>>> 加载用户插件: 优先级 -Infinity (core)，优先级 10 (foo)，优先级 100 (bar, baz)
```

并行加载意味着相同 priority 的插件，其 `setup` 执行顺序不保证。插件之间存在先后依赖时，需要用 priority 拉开层次。

## 运行时插件管理

内置 core 插件提供了一组运行时管理指令。

```text
.plugin list                # 已启用插件
.plugin enable <name>       # 启用，同时写入 mioku.plugins
.plugin disable <name>      # 禁用
.plugin reload <name>       # 重载
```

## 下一步

- [运行时生命周期](/advanced/runtime)：插件加载在启动流程中的位置
- [发布插件](/developer/publish)：manifest 字段的完整说明
- [开发服务](/developer/service-dev)：服务如何被发现与加载
