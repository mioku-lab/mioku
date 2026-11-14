ARG NODE_IMAGE="node:22-bookworm-slim"
ARG BUN_IMAGE="oven/bun:1-debian"
ARG MIOKU_VERSION="latest"

FROM ${NODE_IMAGE} AS node

FROM ${BUN_IMAGE} AS base

USER root
ARG MIOKU_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    LANG=C.UTF-8 \
    TZ=Asia/Shanghai \
    MIOKU_SUPERVISED=1 \
    MIOKU_APP_DIR=/app \
    MIOKU_WEBUI_HOST=0.0.0.0 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# tini 收僵尸进程（chromium 会产生子进程）；libstdc++6 是 node 的运行依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gawk tini tzdata procps less unzip xz-utils libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && bun --version \
 && node --version \
 && npm --version \
 && npx --version

RUN bun add -g "mioku@${MIOKU_VERSION}" \
 && mkdir -p /etc/mioku /usr/local/lib/mioku \
 && printf '{"mioku":"%s"}\n' "$(mioku --version | tr -d 'v')" > /etc/mioku/image.json

COPY app.ts /usr/local/lib/mioku/app.ts
COPY entrypoint.sh /usr/local/bin/mioku-docker
RUN chmod +x /usr/local/bin/mioku-docker

WORKDIR /app
EXPOSE 3339
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/mioku-docker"]

FROM base AS slim

FROM base AS full

# CJK / emoji 字体是截图渲染中文的前提
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ffmpeg fontconfig fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
