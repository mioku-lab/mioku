# Mioku

> AI-powered bot application based on mioki

基于 [mioki](https://mioki.viki.moe/) 的出音味来框架。

## 特性

- 🔌 **插件系统** - 支持独立 Git 仓库管理，支持热插拔
- 🛠️ **服务架构** - 可复用的服务层，插件声明式依赖
- 🤖 **AI Skill 系统** - 插件可注册 Skill，包含多个 AI 工具
- 📚 **帮助系统** - 插件帮助信息自动注册和生成
- ⚙️ **配置管理** - 插件独立配置，支持热更新
- 📦 **Workspace 管理** - 插件和服务独立依赖管理

## 快速开始(推荐)

> 推荐使用bun管理依赖，也可使用npm/pnpm :)

```bash
git clone https://github.com/mioku-lab/mioku.git

cd mioku

# 安装依赖
bun install
```

## 本地启动

```bash
bun run start
```

第一次启动时会自动创建 `config/mioku.json`，并引导你填写 NapCat 正向 WS 配置。

如果当前目录还没有安装 WebUI，首次启动还会额外询问是否现在安装 WebUI。

> 除了 NapCat，还可以使用其他任何符合 OneBot v11 协议的实现端如 LLTwoBot/Lagrange 等。可能会出现少许兼容性问题。

## 安装 WebUI（手动）

```bash
bun run mioku-install webui

# 查看更多功能
bun run mioku-install help
```

安装完成后，再次执行 `bun run start`，首次会提示设置 WebUI 登录密钥。

### 插件/服务安装和管理

推荐使用webui进行管理  
也可手动安装插件，进入config目录配置插件

```bash
bun run mioku-install plugin <repo-url>
bun run mioku-install service <repo-url>
```

### Docker Compose(推荐)

```bash
git clone https://github.com/mioku-lab/mioku.git
cd mioku
docker compose build
docker compose run --rm --service-ports mioku
```

Compose 方案会把当前仓库源码挂载进容器，容器只负责运行环境和依赖。因此运行时管理依赖、安装插件/服务和手动安装操作一致，都在宿主机目录。

> 换句话说，你的本地源码很重要。

首次启动初始化完成后，后续可以使用后台启动：

```bash
docker compose up -d
```

仓库已经提供 [`docker-compose.yml`](./docker-compose.yml)，默认会挂载：

- `./.git -> /app/.git`
- `./config -> /app/config`
- `./data -> /app/data`
- `./logs -> /app/logs`
- `./src -> /app/src`
- `./plugins -> /app/plugins`

这意味着你可以直接修改宿主机上的配置与源码，重启容器后立即生效。

## Docker

```bash
git clone https://github.com/mioku-lab/mioku.git

cd mioku

docker build -t mioku .

docker run --rm -it \
  --name mioku-init \
  --add-host=host.docker.internal:host-gateway \
  -p 3339:3339 \
  -v "$(pwd)/.git:/app/.git" \
  -v "$(pwd)/app.ts:/app/app.ts" \
  -v "$(pwd)/package.json:/app/package.json" \
  -v "$(pwd)/tsconfig.json:/app/tsconfig.json" \
  -v "$(pwd)/install-mioku.ts:/app/install-mioku.ts" \
  -v "$(pwd)/src:/app/src" \
  -v "$(pwd)/plugins:/app/plugins" \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/temp:/app/temp" \
  -v mioku_node_modules:/app/node_modules \
  -v mioku_bun_cache:/root/.bun/install/cache \
  mioku
```

第一次运行会在终端里询问初始配置

配置会写入挂载出来的 `./config`。初始化完成后，可以选用后台模式启动：

```bash
docker run -d \
  --name mioku \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 3339:3339 \
  -v "$(pwd)/.git:/app/.git" \
  -v "$(pwd)/app.ts:/app/app.ts" \
  -v "$(pwd)/package.json:/app/package.json" \
  -v "$(pwd)/tsconfig.json:/app/tsconfig.json" \
  -v "$(pwd)/install-mioku.ts:/app/install-mioku.ts" \
  -v "$(pwd)/src:/app/src" \
  -v "$(pwd)/plugins:/app/plugins" \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/temp:/app/temp" \
  -v mioku_node_modules:/app/node_modules \
  -v mioku_bun_cache:/root/.bun/install/cache \
  mioku
```

### Docker 更新

> 使用Docker安装的方案都不需要每次更新都重新构建

```bash
git pull
docker compose restart mioku
```

如果你使用的是 `docker run` 的模式，对应更新流程为：

```bash
git pull
docker restart mioku
```

如果 `package.json`、插件或服务依赖发生变化，容器启动时会自动执行一次 `bun install`。

## 许可

MIT
