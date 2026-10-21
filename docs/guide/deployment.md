---
title: 部署方式
description: 使用 Docker、pm2 或 systemd 部署 Mioku 机器人。
---

# 部署方式

## Docker

```bash
docker run -it --name mioku \
  -p 3339:3339 \
  -v "$PWD/mioku:/app" -v mioku-packages:/app/node_modules \
  mioku:latest
```

首次启动会在容器里运行创建向导。之后加上 `--restart unless-stopped` 可以后台常驻。镜像目前还没有发布到仓库，需要先 `git clone` 仓库并在本地构建一次，执行 `./docker/build.sh` 即可，不需要在宿主机安装 Node 或 bun。

数据持久化、备份迁移、升级与全部参数见 [Docker 部署](/guide/docker)。

## 使用 pm2

[pm2](https://pm2.io/) 是 Node 生态常用的进程守护工具，进程退出后会自动拉起，也能查看日志。

```bash
npm install -g pm2
```

在项目目录启动。

```bash
pm2 start "bun run start" --name mioku
pm2 save                 # 保存进程列表
pm2 logs mioku           # 查看日志
pm2 restart mioku        # 重启
```

## 开机自启

pm2 自带开机自启。

```bash
pm2 startup
```

执行后会输出一条命令，复制到终端执行一次即可。

## 服务器部署

服务器上的部署流程与本机一致：安装 Node 或 bun，用 `npx mioku` 创建项目，配置适配器，然后 `pm2 start`。

需要注意以下几点。

- **不需要公网**：机器人主动连接 NapCat，使用正向 WebSocket。NapCat 的位置不受限制。
- **截图服务需要 Chromium**：服务器上需要安装 Chrome 或 Edge，否则截图类功能不可用。
- **WebUI 端口**：服务器有防火墙时，需要放行 3339 或改成其他端口。

## 常见问题

### 端口被占用

WebUI 默认端口 3339 被占用时，修改 `config/service/webui/settings.json`。

```json
{
  "port": 3338
}
```

### 使用 systemd

```ini
[Unit]
Description=Mioku Bot
After=network.target

[Service]
WorkingDirectory=/path/to/my-bot
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 下一步

- [Docker 部署](/guide/docker)：容器化部署的完整说明
- [WebUI](/guide/webui)：管理面板的访问与设置
- [配置文件](/guide/configuration)：`config/` 和 `data/` 的约定
