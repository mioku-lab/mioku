---
title: Docker 部署
description: 用 Docker 运行 Mioku，包含首次初始化、数据持久化、备份迁移与升级。
---

# Docker 部署

## 镜像内容

| 组件 | 说明 |
| --- | --- |
| bun / node 22 / npm / npx | bun 是运行时与包管理器，node 供依赖 Node 生态的插件与 `npx` 使用 |
| ffmpeg | 音频、视频与部分媒体插件依赖 |
| chromium 与 Noto CJK 字体 | 截图服务渲染中文图片时需要 |
| mioku CLI | 容器内可以直接执行 `mioku` 和 `npx mioku`，用于创建项目、安装插件、运行适配器向导 |
| tini | 作为 init 进程回收僵尸进程，chromium 会产生子进程 |

镜像有两个 tag。

- `latest` 和 `:<版本号>`：完整版，截图与音视频开箱可用，约 1.2G。
- `slim` 和 `:<版本号>-slim`：不含 chromium 与 ffmpeg，体积小很多，纯逻辑插件够用。

## 快速开始

::: warning 镜像尚未发布
镜像目前没有发布到任何仓库，需要先 clone 仓库并在本地构建一次，见[自己构建镜像](#自己构建镜像)。构建只需要 `docker/` 目录，不需要安装 Node 或 bun。构建出的镜像按 `mioku:latest` 使用。官方镜像发布后，把镜像名换成 `ghcr.io/mioku-lab/mioku:latest`，clone 和构建这一步可以省掉。
:::

首次启动需要交互式终端，创建向导会在容器里运行，流程与 `npx mioku` 完全一致。

```bash
docker run -it --name mioku \
  -p 3339:3339 \
  -v "$PWD/mioku:/app" \
  -v mioku-packages:/app/node_modules \
  mioku:latest
```

向导会依次询问项目名、主人 QQ、适配器、插件和是否安装 WebUI。向导写完后不会中断，同一条命令会直接启动机器人。安装 `stdin` 适配器后可以在终端输入 `.status` 和 `hello` 试用。安装 WebUI 后可以打开 `http://127.0.0.1:3339`，密钥位于 `mioku/config/service/webui/auth.json`。

按 `Ctrl-C` 退出交互，然后改用后台常驻运行。

```bash
docker run -d --name mioku \
  --restart unless-stopped \
  -p 3339:3339 \
  -v "$PWD/mioku:/app" \
  -v mioku-packages:/app/node_modules \
  mioku:latest
```

`--restart unless-stopped` 是必需的。`.restart` 指令在容器里只做干净退出，由 Docker 负责重新拉起。这个参数同时解决崩溃自愈和开机自启。

::: tip 首次初始化中断不会留下垃圾
向导在容器内的临时目录中创建项目，全部完成后才整体写入 `/app`。中途 `Ctrl-C` 不会留下半成品，重新执行一次即可。
:::

## 数据位置

| 路径 | 位置 | 内容 |
| --- | --- | --- |
| `/app` | 宿主目录，例如 `./mioku` | `package.json`、`config/`、`data/`、`logs/`、`temp/`、`plugins/`、`services/`、`backup/` |
| `/app/node_modules` | 命名卷 `mioku-packages` | 框架、插件、服务、适配器与它们的依赖 |

这样切分有两个原因。

- **配置与数据放在宿主机**：它们是机器人真正的资产，容器随时可以删除重建。
- **依赖放在卷里**：依赖是可再生的，`package.json` 就是它的清单。缺失或变更时容器启动会自动重装。迁移时只需要搬少量文件，不用带着几百 MB 的 `node_modules`。

启动时入口脚本会检查 `package.json` 与 `bun.lock` 的哈希，只有变化时才执行 `bun install`。正常重启没有额外开销。

## 备份与迁移

镜像内置了 `mioku-docker` 管理命令，也就是镜像的 entrypoint。

```bash
# 备份到宿主 ./mioku/backup/*.tar.gz，不含 node_modules、temp、logs
docker exec mioku mioku-docker backup

# 备份文件可以直接下载，也可以指定绝对路径
docker cp mioku:/app/backup/xxxx.tar.gz ./xxxx.tar.gz

# 恢复前先停掉机器人，已有项目时要加 --force，会先自动备份当前状态
docker stop mioku
docker run --rm -it \
  -v "$PWD/mioku:/app" -v mioku-packages:/app/node_modules \
  mioku:latest restore --force /app/backup/xxxx.tar.gz
docker start mioku
```

::: warning 热备份与 SQLite
`data/` 中有多个 SQLite 数据库，分别属于 chat、agent、AI 用量和 webui。机器人在运行时备份可能抓到 WAL 中间状态。要求数据绝对一致时，先 `docker stop` 再备份。
:::

迁移到另一台机器只需要两步。

1. 把宿主目录整个拷贝过去，例如 `scp -r mioku user@new-host:~/`，也可以使用上面生成的 tar 包。
2. 在新机器上执行一条 `docker run` 启动。

依赖会按 `package.json` 自动重装。依赖损坏时可以执行 `docker exec mioku mioku-docker heal` 强制重装。拷贝时也可以带上 `backup/` 中的归档，用 `restore` 恢复。

WebUI 也提供备份与恢复，范围是配置和数据，不包含 `package.json` 与 `plugins/`。整机迁移请使用 `mioku-docker backup`。

从裸机迁移过来的项目，`config/service/webui/settings.json` 中通常写着 `"host": "127.0.0.1"`，在容器里外部无法连接。`mioku-service-webui` 会优先采用 `MIOKU_WEBUI_HOST`，镜像已将其设为 `0.0.0.0`，并在启动时把这个值写回配置，所以不需要手动修改。如果 WebUI 服务版本较老，不支持该环境变量，手动把这一行改成 `"0.0.0.0"` 即可。

## 升级

升级等于更换镜像并重建容器。数据都在宿主目录与依赖卷里，不会丢失。取新镜像的方式取决于镜像来源。

```bash
# 官方发布的镜像
docker pull ghcr.io/mioku-lab/mioku:latest

# 自己构建的镜像，更新仓库后重新构建，打上同样的 tag
git pull && ./docker/build.sh

# 重建容器，数据不会丢失
docker rm -f mioku
docker run -d ...                 # 用上面的命令重新启动
```

入口脚本会把项目里低于镜像的框架版本对齐到镜像版本，语义是版本下限。自己用 `.update self` 更新到更新的版本时，容器不会把它降回去。不需要这个行为时，设置 `MIOKU_NO_FRAMEWORK_SYNC=1`。

插件、服务、适配器用 `.update` 指令或 WebUI 更新即可，容器重建不会回退它们。

## 连接聊天平台

容器主动出站连接 NapCat 或 LLOneBot，所以不需要给容器映射任何端口。需要注意宿主机在容器里的地址不是 `localhost`。

```bash
# Docker Desktop，macOS 与 Windows：直接使用 host.docker.internal
docker run ... --add-host=host.docker.internal:host-gateway mioku:latest
# 适配器配置里填 ws://host.docker.internal:3001

# Linux：使用宿主机内网 IP，或者使用 host 网络
docker run ... --network host mioku:latest
```

适配器向导可以随时补跑。

```bash
docker run -it --rm -v "$PWD/mioku:/app" -v mioku-packages:/app/node_modules \
  mioku:latest mioku install adapter onebotv11
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MIOKU_APP_DIR` | `/app` | 项目根目录，与挂载点保持一致 |
| `MIOKU_SUPERVISED` | `1`，镜像内置 | 受管模式，`.restart` 干净退出，交给容器策略重启 |
| `MIOKU_WEBUI_HOST` | `0.0.0.0` | WebUI 监听地址，由 webui 服务读取，优先级高于配置文件，留空则完全由配置文件决定 |
| `MIOKU_WEBUI_PORT` | `3339` | WebUI 端口，同样优先于配置文件 |
| `MIOKU_NO_FRAMEWORK_SYNC` | `0` | 设为 `1` 关闭框架版本下限对齐 |
| `MIOKU_ALLOW_EPHEMERAL` | `0` | 设为 `1` 时不再提醒 `/app` 未挂载 |
| `MIOKU_FORCE` | `0` | `wizard` 与 `restore` 覆盖已有项目时的确认开关 |
| `MIOKU_BACKUP_LOGS` | `0` | 设为 `1` 时备份包含 `logs/` |
| `TZ` | `Asia/Shanghai` | 时区 |

## mioku-docker 子命令

| 命令 | 作用 |
| --- | --- |
| 无参数 | 首次进入创建向导，之后直接启动机器人 |
| `wizard [--force]` | 重新运行创建向导 |
| `backup [文件]` | 备份配置、数据、插件与 `package.json` |
| `restore [--force] <文件>` | 从备份恢复 |
| `heal` | 按 `package.json` 强制重装依赖 |
| `info` | 打印框架版本、工具链版本、路径与访问信息 |
| `shell` | 进入容器 shell |
| 其他命令 | 原样执行，例如 `mioku-docker mioku install plugin 60s` |

## 自己构建镜像

镜像目前没有发布，所以使用 Docker 部署前需要先 clone 仓库。

```bash
git clone --depth 1 https://github.com/mioku-lab/mioku.git
cd mioku

./docker/build.sh          # 构建 full 与 slim，版本号取自 packages/mioku/package.json
./docker/build.sh full     # 只构建完整版
./docker/build.sh slim     # 只构建精简版
```

构建只需要 Docker，不需要在宿主机安装 Node 或 bun。镜像里的 mioku、插件和服务全部从 npm 安装，仓库源码不参与构建。只想获取 `docker/` 这一个目录也可以。

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/mioku-lab/mioku.git
cd mioku && git sparse-checkout set docker && ./docker/build.sh
```

也可以把 `docker/` 中的文件下载到某个目录，然后直接构建。

```bash
docker build --target full -t mioku:latest .
docker build --target slim -t mioku:1.2.2-slim .
```

`build.sh` 支持以下环境变量：`IMAGE`、`VERSION`、`PLATFORM`、`BUN_IMAGE` 和 `NODE_IMAGE`。`IMAGE` 是镜像名，可以用逗号分隔同时推送多个仓库。`VERSION` 是框架版本，默认读取仓库中的版本号，读不到时使用 `latest`。

## 下一步

- [部署方式](/guide/deployment)：pm2 与 systemd 部署
- [配置文件](/guide/configuration)：`config/` 与 `data/` 的约定
- [适配器](/guide/adapters)：安装并配置平台连接
