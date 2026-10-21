---
title: 配置文件
description: Mioku 的框架配置、插件配置、服务配置与数据目录的位置和字段说明。
---

# 配置文件

Mioku 的配置分两部分。框架配置写在项目根目录 `package.json` 的 `mioku` 字段中。插件配置和服务配置放在 `config/` 目录下。备份机器人时只需要处理 `config/` 和 `data/` 两个目录。

## 框架配置

项目创建时生成的 `package.json` 大致如下。

```json
{
  "name": "my-bot",
  "type": "module",
  "dependencies": {
    "mioku": "latest",
    "mioku-adapter-stdin": "latest"
  },
  "mioku": {
    "prefix": ".",
    "owners": ["123456789", "stdin"],
    "admins": [],
    "plugins": ["demo", "help", "chat"],
    "plugins_dir": "plugins",
    "log_level": "info",
    "online_push": false,
    "error_push": false,
    "status_permission": "all",
    "adapters": {
      "stdin": {}
    }
  }
}
```

各字段说明如下。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prefix` | string | `"."` | 系统指令前缀，例如 `.status` |
| `owners` | string[] | `[]` | 主人 QQ 列表，拥有最高权限，必填 |
| `admins` | string[] | `[]` | 管理员 QQ 列表 |
| `plugins` | string[] | `[]` | 启用的插件名列表 |
| `plugins_dir` | string | `"plugins"` | 本地插件目录，插件优先在这里查找 |
| `log_level` | string | `"info"` | 日志级别，可选 `trace` `debug` `info` `warn` `error` `fatal` |
| `online_push` | boolean | `false` | 启动完成后是否向第一个主人推送上线通知 |
| `error_push` | boolean | `false` | 发生错误时是否推送 |
| `status_permission` | string | `"all"` | 谁能查看 `.status` 和 `.adapter`，可选 `all` 或 `admin-only` |
| `adapters` | object | `{}` | 适配器配置，见[适配器](/guide/adapters) |

修改 `package.json` 后需要重启才生效。`.settings` 系列指令，例如 `.settings add-owner`，会直接改写这里的字段。

## 插件配置

插件配置放在 `config/<插件名>/` 下，每个配置文件是一个 JSON 文件。

```text
config/
├── core/
│   ├── base.json            # core 插件基础配置
│   └── access-control.json  # 访问控制
├── chat/
│   ├── base.json
│   ├── settings.json
│   └── personalization.json
└── help/
    ├── demo.json
    └── status.json
```

配置由插件通过配置服务注册和读取。文件保存后插件会收到热重载通知。修改某个插件的配置时，直接编辑对应的 JSON 文件即可，不需要修改代码。

## 服务配置

服务配置放在 `config/service/<服务名>/` 下。

```text
config/service/
└── ai/
    ├── providers.json
    └── models.json
```

服务配置的读写由框架提供，WebUI 的配置页面也基于这套接口。

## 数据目录

插件产生的数据放在 `data/<插件名>/` 下，包括数据库、缓存和下载的文件。

```text
data/
├── chat/
│   └── sessions.json
└── 60s/
    └── data.json
```

升级框架或更换机器时，`config/` 和 `data/` 可以直接拷贝，插件本身通过 npm 重新安装。

## 下一步

- [适配器](/guide/adapters)：配置平台连接
- [WebUI](/guide/webui)：在图形界面中修改配置
- [部署方式](/guide/deployment)：把机器人放到服务器上
