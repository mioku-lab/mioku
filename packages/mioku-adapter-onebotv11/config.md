---
title: onebotv11 适配器配置
description: 配置 OneBot v11 (NapCat) 适配器的正向连接实例与反向连接服务器
fields:
  - key: onebotv11.instances
    label: 正向连接实例
    type: array
    description: 适配器作为客户端主动连接 OneBot 实现（如 NapCat）的 WebSocket 服务
    itemFields:
      - key: protocol
        label: 连接协议
        type: select
        description: ws 未加密，wss 加密（需 NapCat 开启 SSL）。
        options:
          - value: ws
            label: ws (未加密)
          - value: wss
            label: wss (加密)

      - key: host
        label: 主机地址
        type: text
        description: NapCat 所在主机地址。
        placeholder: localhost

      - key: port
        label: 端口
        type: number
        description: NapCat WebSocket 服务端口。
        placeholder: 3001

      - key: token
        label: 访问令牌
        type: secret
        description: NapCat 设置的 access_token，留空表示无令牌。
        placeholder: 可空

      - key: reconnect
        label: 断线自动重连
        type: switch
        description: 连接断开后是否自动重连。
        defaultValue: true

  - key: onebotv11.server.enabled
    label: 反向连接服务器
    type: switch
    description: 启用后适配器在本机监听端口，OneBot 实现（如 NapCat / SnowLuma）主动接入

  - key: onebotv11.server.listenPort
    label: 监听端口
    type: number
    description: 反向 WebSocket 服务器监听端口。
    placeholder: "3939"

  - key: onebotv11.server.path
    label: WebSocket 路径
    type: text
    description: 接受接入的 URL 路径。
    placeholder: /onebot/v11/ws

  - key: onebotv11.server.listenHost
    label: 监听地址
    type: text
    description: 反向 WebSocket 服务器监听地址。
    placeholder: 0.0.0.0

  - key: onebotv11.server.token
    label: 访问令牌
    type: secret
    description: "留空表示不校验。"
    placeholder: 可空
---

# onebotv11 适配器配置

通过 [NapCat](https://napcat.napneko.icu/) 连接 OneBot v11 协议。

## 正向连接

适配器作为 WebSocket 客户端，主动连接 OneBot 实现（如 NapCat）的 WebSocket 服务。

```mioku-field
key: onebotv11.instances
```

## 反向连接服务器

```mioku-field
key: onebotv11.server.enabled
```
```mioku-field
key: onebotv11.server.listenPort
```
```mioku-field
key: onebotv11.server.path
```
```mioku-field
key: onebotv11.server.listenHost
```
```mioku-field
key: onebotv11.server.token
```
