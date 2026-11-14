---
title: WebUI
description: Mioku 可视化管理面板的安装、访问与配置说明。
---

# WebUI

WebUI 是 Mioku 的可视化管理面板，提供插件和服务管理、配置编辑、AI 设置和日志查看等功能。它本身是一个服务。创建项目时选择安装 WebUI 即可，也可以事后安装。

```bash
mioku install service webui
```

## 访问

启动后 WebUI 默认只监听本机回环地址。

```text
http://127.0.0.1:3339
```

## 首次登录

首次访问会提示设置登录密钥。密钥保存在 `config/service/webui/auth.json`。

```json
{
  "token": "your-webui-token",
  "createdAt": 1740000000000,
  "expiresAt": 2050000000000
}
```

## 功能

- **管理插件与服务**：安装、更新、卸载。
- **编辑插件配置**：WebUI 读取插件自带的 `config.md` 规范文件，渲染成自定义配置界面，保存后立即热重载。插件、服务和适配器都可以定义自己的配置界面，写法见[配置与数据存储](/developer/config-data#自定义-webui-配置界面)。
- **查看和修改 AI 配置**：提供商、模型、实例。
- **查看数据库和日志**。
- **检查与更新 Mioku 框架**。

## 修改设置

WebUI 的设置位于 `config/service/webui/settings.json`。

```json
{
  "host": "0.0.0.0",
  "port": 3339,
  "packageManager": "bun"
}
```

修改后需要重启才生效。

## 相关仓库

- [mioku-webui](https://github.com/mioku-lab/mioku-webui.git)：前端面板，使用 Vite、React 和 TailwindCSS。
- [mioku-service-webui](https://github.com/mioku-lab/mioku-service-webui.git)：WebUI 服务。

两个仓库均以 MIT 协议开源。

## 下一步

- [配置文件](/guide/configuration)：配置文件的位置和字段
- [部署方式](/guide/deployment)：把 WebUI 暴露到局域网
- [插件市场](/guide/market)：安装更多插件
