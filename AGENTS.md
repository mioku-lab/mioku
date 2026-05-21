# Repository Guidelines

## Project Structure & Module Organization

Mioku 是一个基于 mioki 的插件框架，代码组织如下：

- `packages/mioku/`: Mioku npm 包源码（**开发用**）
  - `src/index.ts`: 包入口
  - `src/cli.ts`: npx 脚手架工具
  - `src/plugins/`: 内置插件（boot, help, chat）
  - `src/services/`: 内置服务（config, ai, screenshot）
  - `src/core/`: 核心框架代码
  - `dist/`: 构建输出
- `plugins/`: **用户插件目录**（放这里）
- `services/`:**用户服务目录**（放这里）
- `example/`: 测试实例
- `docs/`: VitePress 文档
- `unadapted/`: 未适配的插件和服务

> ⚠️ **重要**：只有 `packages/mioku/src/` 下的代码需要使用包内相对路径（如 `../../service-types`）。
> 用户编写插件时，导入方式与普通 npm 包一致：`import { definePlugin } from "mioki"`

## Build, Test, and Development Commands

```bash
# 构建 mioku 包（根目录执行）
bun run build

# 根目录（文档）
bun run docs:dev
```

## Architecture Rules

Mioku 是 mioki 的上层框架：
- `mioki` 处理插件执行、机器人生命周期和事件分发
- Mioku 添加插件元数据发现、服务发现/加载、自动帮助注册和自动 AI 技能加载

启动流程：
1. `packages/mioku/src/index.ts` 导出 `start()` 函数
2. `start()` 发现插件从 `plugins/*/package.json`（本地）和 `node_modules/mioku-plugin-*`（npm）
3. `start()` 发现服务从 `services/*/package.json`（本地）
4. `plugins/boot` 优先加载（priority -Infinity）
5. `packages/mioku/src/core/plugin-artifact-registry.ts` 自动注册插件帮助和技能

## 用户插件开发

用户编写的插件应放在项目根目录的 `plugins/` 目录下：

```text
my-project/
├── plugins/
│   └── my-plugin/
│       ├── index.ts
│       └── package.json
├── services/           # 用户编写的服务（如有）
├── package.json
└── node_modules/
    └── mioku/           # mioku npm 包
```

**不要修改 `packages/mioku/` 下的内置插件和服务**，如需自定义，请：
1. 在 `plugins/` 目录下创建新插件
2. 或发布为 npm 包 `mioku-plugin-xxx`

## 插件契约

- `package.json -> mioku.services` 声明需要的服务
- `package.json -> mioku.help` 是帮助内容的唯一位置
- `skills.ts` 是插件 AI 技能/工具的唯一位置
- 不要在插件对象上定义 `help` 或 `skill`
- 不要从普通插件调用 `helpService.registerHelp(...)` 或 `aiService.registerSkill(...)`

## 服务契约

- 服务位于 `services/<name>/index.ts`
- 服务导出 `MiokuService`，包含 `name`, `version`, `api`, `init()`, 可选 `dispose()`
- 服务 API 通过 `ctx.services.<name>` 暴露给插件

内置服务（在 `packages/mioku/` 中）：
- `config` - 配置管理
- `ai` - AI 实例管理
- `screenshot` - 网页截图
- `help` - 帮助服务

## Coding Style

使用 TypeScript，2 空格缩进，双引号，分号。