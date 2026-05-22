# 快速开始

> 本教程适用全系统，包括但不限于 Mac/Win/Linux，只需要打开系统的终端按照教程操作即可 ;]

## 环境要求

- 一台服务器，不需要公网，运行内存大于 100M 即可
- [bun](https://bun.sh/) JavaScript 运行时和包管理工具

> 一键安装 bun 命令: `npm install -g bun`

- [git](https://git-scm.com/) 用于版本管理和插件安装
- chromium 内核的浏览器，用于系统截图服务，缺失将无法使用大部分插件功能

> 常见支持的浏览器有 Chrome(推荐) / Edge / chromium(Chrome的开源版本)

- [ffmpeg](https://ffmpeg.org/) 用于音频与视频处理，部分插件可能用到
- 一个可连接的 [NapCat](https://doc.napneko.icu/) / [OneBot v11](https://onebot.dev/) 实现端

## 安装

使用 `npx mioku` 一键创建项目：

```bash
npx mioku
```

命令会引导你填写：

- 项目名称
- NapCat 地址 (正向 WebSocket 连接，即 Mioku 作为客户端)
- NapCat 端口
- NapCat token
- 主人 QQ
- 是否安装 WebUI

> 示例配置：
> NapCat 地址: localhost
> Napcat 端口: 7000
> NapCat token: 114514
> ...

## 启动

```bash
cd <项目名称>
bun run start
```

## 下一步

- [WebUI 的安装与使用](/guide/webui)
- [了解配置文件规范](/guide/configuration)
- [查看插件市场](/guide/plugin-market)

## 开发命令

```bash
bun run dev      # 开发模式
bun run build    # 构建包，通常用于检测是否有问题
bun run docs:dev # 文档开发模式
bun run docs:build # 文档构建
```
