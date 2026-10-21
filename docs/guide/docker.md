---
title: Docker 部署
description: 用 Docker 一键跑起 Mioku，含首次初始化、数据持久化、升级与迁移
---

# Docker 部署

## 镜像里有什么

| 组件                        | 说明                                          |
|---------------------------|---------------------------------------------|
| bun / node 22 / npm / npx | bun 是运行时与包管理器，node 供依赖 node 生态的插件与 `npx` 使用 |
| ffmpeg                    | 音频、视频与部分媒体插件依赖                              |
| chromium + Noto CJK 字体    | 截图服务（`mioku-service-screenshot`）渲染中文图片      |
| mioku CLI                 | 容器内可直接 `mioku`、`npx mioku` 创建项目、装插件、跑适配器向导  |
| tini                      | 作为 init 收僵尸进程（chromium 会产生子进程）              |

两个 tag：

- `latest` / `:<版本号>`：完整版，截图与音视频开箱可用（约 1.2G）
- `slim` / `:<版本号>-slim`：不含 chromium 与 ffmpeg，体积小很多，纯逻辑插件够用

## 快速开始

> **镜像目前还没有发布到任何仓库**，所以要先 clone 仓库、本地构建一次
> （见[自己构建镜像](#自己构建镜像)，只需要 `docker/` 目录，不用装 node / bun）。
> 构建出来的镜像名按 `mioku:latest` 用即可；等官方镜像发布后，把镜像名换成
> `ghcr.io/mioku-lab/mioku:latest`，clone 和构建这一步就可以省掉。

首次启动需要交互式终端，创建向导（和 `npx mioku` 完全一样）会在容器里跑：

```bash
docker run -it --name mioku \
  -p 3339:3339 \
  -v "$PWD/mioku:/app" \
  -v mioku-packages:/app/node_modules \
  mioku:latest
```

向导里会依次问你项目名、主人 QQ、适配器、插件、是否装 WebUI。**向导写完后不会中断**，
同一条命令会直接启动机器人：装了 `stdin` 适配器就能在终端里输入 `.status`、`hello` 试玩，
装了 WebUI 就能打开 `http://127.0.0.1:3339`（密钥见 `mioku/config/service/webui/auth.json`）。

之后改成后台常驻运行（`Ctrl-C` 退出交互，再执行）：

```bash
docker run -d --name mioku \
  --restart unless-stopped \
  -p 3339:3339 \
  -v "$PWD/mioku:/app" \
  -v mioku-packages:/app/node_modules \
  mioku:latest
```

`--restart unless-stopped` 是必须的：`.restart` 指令在容器里只做"干净退出"，
由 Docker 负责把它拉起来；顺带也解决了崩溃自愈和开机自启。

::: tip 首次初始化没跑完也不会脏
向导在容器内的临时目录里创建项目，全部完成后才整体写入 `/app`。
中途 `Ctrl-C` 不会留下半成品，重新执行一次即可。
:::

## 数据放在哪里

| 路径 | 位置 | 内容 |
|---|---|---|
| `/app` | 宿主目录（例：`./mioku`） | `package.json`（配置 + 依赖清单）、`config/`、`data/`、`logs/`、`temp/`、`plugins/`、`services/`、`backup/` |
| `/app/node_modules` | 命名卷 `mioku-packages` | 框架、插件、服务、适配器与它们的依赖 |

这样切分的原因：

- **配置与数据必须在宿主机**：它们是这个机器人真正的资产，容器随时可以删掉重建
- **依赖放卷里**：它是可再生的；`package.json` 就是它的"配方"，缺失或变更时容器启动会自动重装。
  这样迁移时只需要搬少量文件，不用带着几百 MB 的 `node_modules` 跑

启动时入口脚本会检查 `package.json` / `bun.lock` 的哈希，只有变化时才 `bun install`，
正常重启是零开销的。

## 数据迁移与备份

容器内置了 `mioku-docker` 管理命令（就是镜像的 entrypoint）：

```bash
# 备份（写到宿主 ./mioku/backup/*.tar.gz，不含 node_modules / temp / logs）
docker exec mioku mioku-docker backup

# 备份文件可以直接下载走，也可以指定绝对路径
docker cp mioku:/app/backup/xxxx.tar.gz ./xxxx.tar.gz

# 恢复（需要先停掉机器人；已有项目时要加 --force，会先自动备份当前状态）
docker stop mioku
docker run --rm -it \
  -v "$PWD/mioku:/app" -v mioku-packages:/app/node_modules \
  mioku:latest restore --force /app/backup/xxxx.tar.gz
docker start mioku
```

::: warning 热备份与 SQLite
`data/` 里有多个 SQLite 数据库（chat、agent、ai 用量、webui 等）。
机器人在跑的时候备份，可能抓到 WAL 中间状态。要求绝对一致就先 `docker stop` 再备份。
:::

**迁移到另一台机器**只有两步：

1. 把宿主目录整个拷过去（`scp -r mioku user@new-host:~/`，或者用上面的 tar）
2. 在新机器上一条 `docker run` 启动

依赖会自动按 `package.json` 重装；坏了就 `docker exec mioku mioku-docker heal` 强制重来。
拷贝时也可以带上 `backup/` 里的归档，用 `restore` 恢复。

WebUI 里也有备份 / 恢复（配置 + 数据），但它不包含 `package.json` 与 `plugins/`，
做整机迁移时请用 `mioku-docker backup`。

从裸机迁过来的项目，`config/service/webui/settings.json` 里通常写着 `"host": "127.0.0.1"`，
这在容器里外部连不上。`mioku-service-webui` 会优先采用 `MIOKU_WEBUI_HOST`（镜像已设为 `0.0.0.0`）
并在启动时把这个值写回配置，所以不用手动改；如果 WebUI 服务版本较老（不支持该环境变量），
手动把这一行改成 `"0.0.0.0"` 即可。

## 升级

升级 = **换镜像** + 重建容器，数据都在宿主目录与依赖卷里，不会丢。镜像来源不同，取新镜像的方式不同：

```bash
# ① 用官方发布的镜像（发布开关打开后）
docker pull ghcr.io/mioku-lab/mioku:latest

# ② 自己构建的镜像：更新仓库后重新构建，打上同样的 tag
git pull && ./docker/build.sh

# 然后重建容器
docker rm -f mioku                # 数据不会丢
docker run -d ...                 # 用上面的命令重新起一个
```

入口脚本会把项目里低于镜像的框架版本对齐到镜像版本（"下限"语义）：
你自己用 `.update self` 更新到更新的版本时，容器不会把它降回去。
不想要这个行为可以设 `MIOKU_NO_FRAMEWORK_SYNC=1`。

插件、服务、适配器用 `.update` 指令或 WebUI 更新即可，容器重建不会回退它们。

## 连接聊天平台

容器是主动出站连接 NapCat / LLOneBot 的，所以**不需要给容器映射任何端口**，
但要注意"宿主机"在容器里的地址不是 `localhost`：

```bash
# Docker Desktop（Mac / Windows）：直接写 host.docker.internal
docker run ... --add-host=host.docker.internal:host-gateway mioku:latest
# 适配器配置里填 ws://host.docker.internal:3001

# Linux：用宿主机内网 IP，或者用 host 网络
docker run ... --network host mioku:latest
```

适配器向导可以随时补跑：

```bash
docker run -it --rm -v "$PWD/mioku:/app" -v mioku-packages:/app/node_modules \
  mioku:latest mioku install adapter onebotv11
```

## 环境变量

| 变量                        | 默认              | 说明                                |
|---------------------------|-----------------|-----------------------------------|
| `MIOKU_APP_DIR`           | `/app`          | 项目根目录，与挂载点保持一致                    |
| `MIOKU_SUPERVISED`        | `1`（镜像内置）       | 受管模式：`.restart` 干净退出，交给容器策略重启     |
| `MIOKU_WEBUI_HOST`        | `0.0.0.0`       | WebUI 监听地址，由 webui 服务读取；优先级高于 `config/service/webui/settings.json`，留空则完全由配置文件决定 |
| `MIOKU_WEBUI_PORT`        | `3339`          | WebUI 端口，同样优先于配置文件               |
| `MIOKU_NO_FRAMEWORK_SYNC` | `0`             | 设为 `1` 关闭"框架版本下限对齐"               |
| `MIOKU_ALLOW_EPHEMERAL`   | `0`             | 设为 `1` 时不再提醒 `/app` 未挂载           |
| `MIOKU_FORCE`             | `0`             | `wizard` / `restore` 覆盖已有项目的确认开关  |
| `MIOKU_BACKUP_LOGS`       | `0`             | 设为 `1` 时备份包含 `logs/`              |
| `TZ`                      | `Asia/Shanghai` | 时区                                |

## mioku-docker 子命令

| 命令                       | 作用                                              |
|--------------------------|-------------------------------------------------|
| 无参数                      | 首次进入创建向导，之后直接启动机器人                              |
| `wizard [--force]`       | 重新运行创建向导                                        |
| `backup [文件]`            | 备份配置 / 数据 / 插件 / `package.json`                 |
| `restore [--force] <文件>` | 从备份恢复                                           |
| `heal`                   | 按 `package.json` 强制重装依赖                         |
| `info`                   | 打印框架版本、工具链版本、路径与访问信息                            |
| `shell`                  | 进入容器 shell                                      |
| 其它                       | 原样执行，例如 `mioku-docker mioku install plugin 60s` |

## 自己构建镜像

**镜像目前没有发布**，所以走 Docker 这条路先要 clone 仓库：

```bash
git clone --depth 1 https://github.com/mioku-lab/mioku.git
cd mioku

./docker/build.sh          # full + slim，版本号取自 packages/mioku/package.json
./docker/build.sh full     # 只要完整版（截图 / 音视频）
./docker/build.sh slim     # 只要精简版
```

构建只需要 **Docker**，不需要在宿主机装 node / bun：镜像里的 mioku、插件、服务全部从 npm 装，
仓库源码不参与构建。只想拿 `docker/` 这个目录（5 个小文件）也可以：

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/mioku-lab/mioku.git
cd mioku && git sparse-checkout set docker && ./docker/build.sh
```

或者直接把 `docker/` 里的文件下载到某个目录，然后：

```bash
docker build --target full -t mioku:latest .
docker build --target slim -t mioku:1.2.2-slim .
```

`build.sh` 可用环境变量：`IMAGE`（镜像名，可用逗号分隔同时推多个仓库）、`VERSION`
（框架版本，默认读仓库里的版本号，读不到就用 `latest`）、`PLATFORM`、`BUN_IMAGE` / `NODE_IMAGE`。