# 配置文件规范

> Mioku的配置文件位于根目录`config`下，插件的数据存在`data`下，备份时注意这两个目录即可

## 入口配置

`package.json`

一个示例的配置如下

```json
{
  "mioki": {
    "prefix": "/",
    "owners": [123456789],
    "admins": [],
    "plugins": ["boot", "help", "chat"],
    "log_level": "info",
    "online_push": false,
    "error_push": true,
    "napcat": [
      {
        "protocol": "ws",
        "host": "127.0.0.1",
        "port": 3000,
        "token": "your-token"
      }
    ]
  }
}
```

## 字段

### `owners`

主人 QQ 列表。

```json
{
  "owners": [123456789]
}
```

### `admins`

管理员 QQ 列表。

```json
{
  "admins": [111111111, 222222222]
}
```

### `plugins`

启用的插件列表。

```json
{
  "plugins": ["boot", "help", "chat", "hello"]
}
```

### `napcat`

OneBot 实现端连接配置，支持多个 NapCat 实例，以数组形式填入。

```json
{
  "napcat": [
    {
      "protocol": "ws",
      "host": "127.0.0.1",
      "port": 3000,
      "token": "your-token"
    }
  ]
}
```

## 插件配置

插件配置统一放在：

```text
config/<plugin-name>/*.json
```

例如 `chat` 插件：

```text
config/chat/base.json
config/chat/settings.json
config/chat/personalization.json
```

## WebUI 配置

WebUI 相关配置位于：

```text
config/webui/settings.json
config/webui/auth.json
```

> 了解[如何在插件中管理插件配置](/developer/plugin-advanced)
