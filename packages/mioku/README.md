# Mioku

> AI-powered bot application based on mioki

基于 [mioki](https://mioki.viki.moe/) 的聊天机器人框架。

## 特性

- 🔌 **插件系统** - 支持独立 npm 包管理，支持热插拔
- 🛠️ **服务架构** - 可复用的服务层，插件声明式依赖
- 🤖 **AI Skill 系统** - 插件可注册 Skill，包含多个 AI 工具
- 📚 **帮助系统** - 插件帮助信息自动注册和生成
- ⚙️ **配置管理** - 插件独立配置，支持热更新
- 📦 **Workspace 管理** - 使用 bun workspace，插件和服务独立依赖管理

## 环境要求

- [bun](https://bun.sh/) JavaScript 运行时和包管理工具

> 一键安装 bun 命令: `npm install -g bun`

- [git](https://git-scm.com/) 用于版本管理和插件安装
- chromium 内核的浏览器，用于系统截图服务，缺失将无法使用大部分插件功能

> 常见支持的浏览器有 Chrome(推荐) / Edge / chromium(Chrome的开源版本)

- [ffmpeg](https://ffmpeg.org/) 用于音频与视频处理，部分插件可能用到
- 一个可连接的 [NapCat](https://doc.napneko.icu/) / [OneBot v11](https://onebot.dev/) 实现端

## 快速开始

使用 `npx mioku` 一键创建项目：

```bash
npx mioku
```

首次启动时会自动询问 mioki 相关配置字段，并引导你填写 NapCat 正向 WS 配置。

首次启动还会询问是否安装 WebUI。

> 除了 NapCat，还可以使用其他任何符合 OneBot v11 协议的实现端如 LLTwoBot/Lagrange 等。可能会出现少许兼容性问题。

## 启动

```bash
cd <项目名称>
bun run start
```

## 插件/服务安装

> 推荐使用 WebUI 管理插件/服务

使用 `npx mioku` 命令安装或更新插件/服务：

```bash
# 安装插件
npx mioku install plugin <名称>
# 例如: npx mioku install plugin 60s

# 安装服务
npx mioku install service <名称>
# 例如: npx mioku install service ai

# 更新所有 mioku 相关包
npx mioku update all

# 更新 mioku 框架本身
npx mioku update self
```

## WebUI

WebUI 会随框架自动加载，访问 http://127.0.0.1:3339 进入管理界面。

首次启动会提示设置登录密钥。

## 开发

```bash
# 开发模式
bun run dev

# 构建 mioku 包
bun run build

# 文档开发
bun run docs:dev
bun run docs:build
```

## 许可

MIT
