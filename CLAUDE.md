# CLAUDE.md

This file provides repository-specific instructions for coding agents working on Mioku.

## What Mioku Is

Mioku extends `mioki`.

- `mioki` handles bot connections, plugin execution, and event dispatch.
- Mioku adds plugin metadata discovery, service discovery/loading, help auto-registration, and AI skill auto-loading.

Treat the checked-out source as the source of truth when docs and code differ.

## Key Commands

```bash
# 构建 mioku 包
bun run build

# 构建文档
bun run docs:dev
bun run docs:build
```

## Repository Layout

- `packages/mioku/`: Mioku npm 包源码
  - `src/index.ts`: 包入口，导出 start() 和所有内置插件/服务
  - `src/cli.ts`: npx 入口，交互式脚手架
  - `src/core/`: 核心框架代码
  - `dist/`: 构建输出
- `packages/mioku-plugin-*/`: 内置插件 (boot, help, chat 等)
- `packages/mioku-service-*/`: 内置服务 (config, ai, screenshot, help 等)
- `example/`: 测试实例
- `docs/`: VitePress 文档

## 包管理

项目使用 `bun` 作为包管理工具，固定版本在 `packageManager` 字段。

插件和服务通过 npm 包发布，不再使用 `src/services/*` 或 `plugins/*` 本地目录结构。

## 数据目录

插件需要持久化数据时，应将数据存放在项目目录下的 `data` 目录中。使用 `mioku` 提供的数据路径工具：

```typescript
import { getPluginDataDir, ensureDataDir } from "mioku";
```

## 开发

```bash
# 克隆仓库
git clone https://github.com/mioku-lab/mioku.git

cd mioku

# 构建 mioku 包
bun install
bun run build

# 文档开发
bun run docs:dev
```