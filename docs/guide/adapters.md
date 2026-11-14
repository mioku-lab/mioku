---
title: 适配器
description: Mioku 适配器负责对接具体平台，接收事件并调用平台接口。
---

# 适配器

适配器 Adapter 是机器人与平台之间的桥梁，负责两件事。

- **接收事件**：把驱动器收到的消息转换成 Mioku 定义的事件模型，交给插件处理。
- **调用平台接口**：把插件要调用的接口数据转换成平台指定的格式，交给驱动器发送，并接收返回数据。

对插件来说适配器是透明的。插件只调用能力，不关心背后是哪个平台。同一个插件可以不加修改地运行在 QQ、终端以及其他平台上。

## 安装与启用

适配器是普通的 npm 包。安装到项目的 `dependencies` 后，在 `mioku.adapters` 中启用。创建项目时用 `npx mioku` 选择即可，也可以手动安装。

```bash
bun add mioku-adapter-onebotv11
```

```json
{
  "mioku": {
    "adapters": {
      "onebotv11": {
        "instances": []
      }
    }
  }
}
```

框架启动时在项目的直接依赖中查找 `mioku-adapter-` 前缀的包，然后按 `mioku.adapters` 中的配置逐个启动。适配器必须安装在 `dependencies` 中。放在 `devDependencies` 中不会被发现。

## 配置向导

适配器可以自带 CLI 配置向导。在项目目录执行 `mioku-adapter-<名称>` 或 `bunx mioku-adapter-<名称>`，会启动交互式向导，生成 `mioku.adapters` 中的配置。创建项目时选择了适配器，向导会自动运行。

## 多账号

所有适配器都支持多实例。每个实例对应一个 bot。插件可以取得全部 bot，也可以按 bot_id 取单个，详见[操作 Bot](/developer/bot)。

## 开发适配器

适配器接口是开放的。适配器只需实现创建函数和启动停止逻辑，再注册一批能力。想为某个平台编写适配器，见[开发适配器](/developer/adapter-dev)。

## 下一步

- [配置文件](/guide/configuration)：`mioku.adapters` 的写法
- [操作 Bot](/developer/bot)：用插件调用机器人
- [开发适配器](/developer/adapter-dev)：为新平台编写适配器
