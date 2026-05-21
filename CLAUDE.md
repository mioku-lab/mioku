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

# 在根目录构建文档
bun run docs:dev
bun run docs:build
```

## Repository Layout

- `packages/mioku/`: Mioku npm 包源码
  - `src/index.ts`: 包入口，导出 start() 和所有内置插件/服务
  - `src/cli.ts`: npx 入口，交互式脚手架
  - `src/plugins/`: 内置插件（boot, help, chat）
  - `src/services/`: 内置服务（config, ai, screenshot）
  - `src/core/`: 核心框架代码
  - `dist/`: 构建输出
- `plugins/`: 本地插件（示例）
- `example/`: 测试实例
- `unadapted/`: 未适配的插件和服务（需要适配才能使用）
- `docs/`: VitePress 文档
- `mioku-webui/`: WebUI 界面（独立仓库）

## 内置插件/服务

所有内置插件和服务都在 `packages/mioku/` 包中：

### 内置插件
- **boot**: 系统启动插件 (priority -Infinity)
- **help**: 帮助图片生成
- **chat**: AI 聊天

### 内置服务
- **config**: 配置管理
- **ai**: AI 实例管理
- **screenshot**: 网页截图

## 构建流程

1. `npx mioku` 使用 cli.ts 创建项目
2. 项目中 `bun add mioku` 安装框架
3. 框架自动发现 node_modules 中的 mioku-plugin-* 插件
4. 运行时通过 `start()` 启动

## 开发

```bash
# 克隆仓库
git clone https://github.com/jerryplusy/mioku.git

# 构建 mioku 包
bun install
bun run build

# 或在根目录（构建文档）
bun run docs:dev
```