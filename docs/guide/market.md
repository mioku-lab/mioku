---
title: 插件市场
description: 在 Mioku 插件市场中安装、更新插件与服务，或发布自己的插件。
---

# 插件市场

<StoreRegistry />

## 安装插件

```bash
mioku install plugin <名称>
```

命令会自动补全 `mioku-plugin-` 前缀，所以可以只写短名。

```bash
mioku install plugin 60s     # 等价于 mioku install plugin mioku-plugin-60s
```

安装服务的命令相同。

```bash
mioku install service webui
```

安装插件时，CLI 会读取插件 `package.json` 中 `mioku.services` 声明的服务依赖，把缺少的服务一并装上。

也可以直接用 bun 安装。

```bash
bun add mioku-plugin-60s
```

用 bun 安装后，需要在 `package.json` 的 `mioku.plugins` 中加上短名 `60s`，否则框架不会加载它。

## 更新

```bash
mioku update          # 检查所有 mioku-* 包是否有可用更新
mioku update all      # 更新全部
mioku update self     # 更新 mioku 框架本身
mioku update 60s      # 更新指定包
```

## 在聊天中安装

安装 `admin` 插件后，可以直接在聊天中操作。

- `.plugin-market`：查看可安装的插件列表
- `.install plugin <名称>`：安装插件
- `.install service <名称>`：安装服务
- `.uninstall plugin/service <名称>`：卸载
- `.update`：查看并选择更新

## 发布插件

想把自己的插件发布到市场，流程见[发布插件](/developer/publish)。`package.json` 的 `keywords` 中需要包含 `mioku`，这是市场搜索的依据。

## 下一步

- [发布插件](/developer/publish)：把插件分享给别人
- [配置文件](/guide/configuration)：`mioku.plugins` 的写法
- [WebUI](/guide/webui)：用图形界面管理插件
