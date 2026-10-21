---
title: WebUI
description: Mioku 可视化管理面板的使用指南
---

# WebUI

WebUI 是 Mioku 的可视化管理面板，提供插件 / 服务管理、配置编辑、AI 设置、日志查看等功能。它本身是一个服务，创建项目时勾选「安装 WebUI」即可，也可以事后补装：

```bash
mioku install service webui
```

## 访问

启动后 WebUI 默认只监听本机回环地址：

```text
http://127.0.0.1:3339
```

## 首次登录

首次访问会提示设置登录密钥，密钥保存在：

```text
config/service/webui/auth.json
```

```json
{
  "token": "your-webui-token",
  "createdAt": 1740000000000,
  "expiresAt": 2050000000000
}
```

## 能做什么

- **管理插件与服务**：安装、更新、卸载
- **编辑插件配置**：WebUI 会读取插件自带的 `config.md` 规范文件，渲染成自定义配置界面，改完保存即热重载。插件、服务、适配器都能用 `config.md` 定义自己的配置界面，写法见[给 WebUI 提供配置界面](/developer/config-data#给-webui-提供配置界面configmd)
- **查看和修改 AI 配置**：提供商、模型、实例
- **查看数据库和日志**
- **检查与更新 Mioku 框架**

## 修改设置

WebUI 自己的设置位于：

```text
config/service/webui/settings.json
```

```json
{
  "host": "0.0.0.0",
  "port": 3339,
  "packageManager": "bun"
}
```

改完重启生效。

## 相关仓库

- [mioku-webui](https://github.com/mioku-lab/mioku-webui.git) —— 前端面板（Vite + React + TailwindCSS）
- [mioku-service-webui](https://github.com/mioku-lab/mioku-service-webui.git) —— WebUI 服务

两者均以 MIT 协议开源。
