---
title: 快速开始
description: 用 5 分钟跑通第一个 Mioku 机器人，并在终端里与它对话。
---

# 快速开始

本教程适用于 macOS、Windows 和 Linux。打开系统终端，按下面的步骤操作即可。

## 环境要求

- Node.js 22.18 及以上版本，或者 bun。项目默认使用 bun 作为运行时和包管理器。
- Chromium 内核浏览器，例如 Chrome、Edge 或 Chromium。截图服务需要它，缺失会导致多数插件功能不可用。
- ffmpeg。音频和视频处理会用到它，部分插件依赖。

如果只想先体验框架，Chromium 和 ffmpeg 可以暂时不装，装好 bun 即可。已有 Node.js 时，可以用 `npm install -g bun` 安装 bun。

## 创建项目

使用 `npx mioku` 创建项目。使用 bun 时改用 `bunx mioku`。

```bash
npx mioku
```

命令会交互式引导填写以下内容。

- **项目名称**：例如 `my-bot`
- **主人 QQ**：机器人管理员的 QQ 号，必填
- **适配器**：要接入的平台
- **插件**：从 npm 市场挑选要安装的插件
- **WebUI**：是否安装管理面板，建议安装

选择 `onebotv11` 等适配器后，项目创建完成会自动运行适配器的连接向导，引导填写 NapCat 地址、端口和 token。详见[适配器](/guide/adapters)。

## 在终端试用

创建好的项目默认启用 `mioku-adapter-stdin`，不接任何平台也能运行。进入项目目录启动。

```bash
cd my-bot
bun run start
```

启动完成后，直接在终端输入下列内容。

| 输入 | 作用 |
| --- | --- |
| `.status` | 查看运行状态 |
| `.adapter` | 查看适配器与连接实例 |
| `hello` | 与内置示例插件交互 |
| `.help` | 查看系统指令 |

## 接入聊天平台

终端只用于调试。接入聊天平台需要安装适配器并配置连接，有两种方式。

1. 创建项目时选择了适配器，例如 `onebotv11`，向导已经写好配置。
2. 创建项目后手动修改配置。

```json
{
  "mioku": {
    "adapters": {
      "onebotv11": {
        "instances": [
          { "protocol": "ws", "host": "localhost", "port": 3001, "token": "" }
        ]
      }
    }
  }
}
```

然后执行 `bun run start`。日志出现 `成功连接 x 个实例` 表示连接成功。适配器的安装与配置详见[适配器](/guide/adapters)。

## 系统指令

以下指令由内置的 core 插件提供，默认需要主人权限。前缀 `.` 可以在配置中修改。

| 指令 | 作用 |
| --- | --- |
| `.help` | 查看帮助 |
| `.status` | 查看运行状态 |
| `.adapter` | 查看适配器与连接实例 |
| `.log` | 查看最近 100 条日志 |
| `.plugin list / enable / disable / reload` | 插件管理 |
| `.settings detail / add-owner / add-admin` | 框架设置管理 |
| `.install plugin/service <名称>` | 安装插件或服务 |
| `.uninstall plugin/service <名称>` | 卸载插件或服务 |
| `.plugin-market` / `.service-market` | 查看插件市场或服务市场 |
| `.update [all/self/包名]` | 更新 |
| `.restart` | 重启进程 |
| `.exit` | 退出进程 |

也可以直接在项目根目录用 bun 安装插件，例如 `bun add mioku-plugin-60s`。安装后在 `package.json` 的 `mioku.plugins` 中加上短名 `60s`，然后重启。完整列表见[插件市场](/guide/market)。

## 下一步

- [认识 Mioku](/guide/introduction)：理解插件、服务和适配器的关系
- [适配器](/guide/adapters)：接入 QQ 或多账号
- [配置文件](/guide/configuration)：`mioku` 字段全解
- [第一个插件](/developer/first-plugin)：开始编写插件
