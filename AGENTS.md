# Repository Guidelines

## Project Structure & Module Organization

Mioku 是一个基于 mioki 的插件框架，代码组织如下：

- `packages/mioku/`: Mioku npm 包源码
  - `src/index.ts`: 包入口，导出 start() 和所有内置插件/服务
  - `src/cli.ts`: npx 脚手架工具
  - `src/core/`: 核心框架代码
  - `dist/`: 构建输出
- `packages/mioku-plugin-*/`: 内置插件 (boot, help, chat 等)
- `packages/mioku-service-*/`: 内置服务 (config, ai, screenshot, help 等)
- `example/`: 测试实例
- `docs/`: VitePress 文档

> ⚠️ **重要**：内置插件和服务位于 `packages/mioku-plugin-*/` 和 `packages/mioku-service-*/`
> 用户插件通过 npm 安装或放在 `plugins/` 目录

## Build, Test, and Development Commands

```bash
# 构建 mioku 包（根目录执行）
bun run build

# 文档开发
bun run docs:dev
```

## 包管理

项目使用 `bun` 作为包管理工具，固定版本在 `packageManager` 字段。

插件和服务通过 npm 包发布，不再使用 `src/services/*` 或 `plugins/*` 本地目录结构。

## 数据目录

插件需要持久化数据时，应将数据存放在项目目录下的 `data` 目录中：

```typescript
import { getPluginDataDir, ensureDataDir } from "mioku";
```

## 用户插件开发

用户编写的插件应通过 npm 安装或放在 `plugins/` 目录下：

```text
my-project/
├── plugins/              # 本地插件（可选）
│   └── my-plugin/
│       ├── index.ts
│       └── package.json
├── package.json
└── node_modules/
    └── mioku/           # mioku npm 包
```

使用 `npx mioku` 安装插件：

```bash
npx mioku install plugin <名称>
```

**不要修改 `packages/mioku/` 下的内置插件和服务**，如需自定义，请发布为 npm 包 `mioku-plugin-xxx`。

## 插件契约

- `package.json -> mioku.services` 声明需要的服务
- `package.json -> mioku.help` 是帮助内容的唯一位置
- `skills.ts` 是插件 AI 技能/工具的唯一位置
- 不要在插件对象上定义 `help` 或 `skill`
- 不要从普通插件调用 `helpService.registerHelp(...)` 或 `aiService.registerSkill(...)`

## 服务契约

- 服务位于 `packages/mioku-service-*/`
- 服务导出 `MiokuService`，包含 `name`, `version`, `api`, `init()`, 可选 `dispose()`
- 服务 API 通过 `ctx.services.<name>` 暴露给插件

内置服务：
- `config` - 配置管理
- `ai` - AI 实例管理
- `screenshot` - 网页截图
- `help` - 帮助服务

## Coding Style

使用 TypeScript，2 空格缩进，双引号，分号。