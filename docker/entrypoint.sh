#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${MIOKU_APP_DIR:-/app}"
IMAGE_INFO="/etc/mioku/image.json"
TEMPLATE_APP="/usr/local/lib/mioku/app.ts"
DEPS_STAMP="$APP_DIR/.mioku-docker-deps"
WEBUI_HOST="${MIOKU_WEBUI_HOST:-127.0.0.1}"
WEBUI_PORT="${MIOKU_WEBUI_PORT:-3339}"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_OFF=""
fi

log() { printf '%s[mioku]%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok() { printf '%s[mioku]%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s[mioku]%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die() {
  printf '%s[mioku]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2
  exit 1
}

usage() {
  printf '用法: %s [子命令]\n' "$(basename "$0")"
  printf '子命令: wizard | backup | restore | heal | info | shell；其它参数原样 exec\n'
  printf '无参数时：首次进入创建向导，之后启动机器人（详见 docs/guide/docker.md）\n'
}

has_project() { [ -f "$APP_DIR/package.json" ]; }

image_mioku_version() {
  [ -f "$IMAGE_INFO" ] || return 0
  sed -n 's/.*"mioku"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$IMAGE_INFO" | head -n 1
}

installed_mioku_version() {
  local file="$APP_DIR/node_modules/mioku/package.json"
  [ -f "$file" ] || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

version_lt() {
  [ -n "$1" ] && [ -n "$2" ] && [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

deps_hash() {
  {
    cat "$APP_DIR/package.json" 2>/dev/null || true
    cat "$APP_DIR/bun.lock" 2>/dev/null || true
  } | sha256sum | awk '{print $1}'
}

install_deps() {
  log "安装项目依赖（bun install）..."
  local code=0
  (cd "$APP_DIR" && bun install) || code=$?
  if [ "$code" -ne 0 ]; then
    if [ -d "$APP_DIR/node_modules/mioku" ]; then
      warn "bun install 失败（退出码 ${code}），继续使用现有 node_modules"
      return 0
    fi
    die "bun install 失败（退出码 ${code}），请检查网络与 $APP_DIR/package.json"
  fi
  deps_hash >"$DEPS_STAMP"
  ok "依赖已就绪"
}

# package.json / bun.lock 变化，或依赖卷为空时重装
ensure_deps() {
  local current stored
  current="$(deps_hash)"
  stored="$(cat "$DEPS_STAMP" 2>/dev/null || true)"
  if [ ! -d "$APP_DIR/node_modules/mioku" ] || [ "$current" != "$stored" ]; then
    install_deps
  fi
}

# 镜像版本是下限：项目落后就补齐，已在更新版本上不动
sync_framework_floor() {
  [ "${MIOKU_NO_FRAMEWORK_SYNC:-0}" = "1" ] && return 0
  local target current
  target="$(image_mioku_version)"
  [ -n "$target" ] || return 0
  current="$(installed_mioku_version || true)"
  [ -n "$current" ] || return 0
  version_lt "$current" "$target" || return 0

  log "项目框架版本 $current 低于镜像内置 ${target}，正在对齐..."
  if (cd "$APP_DIR" && bun add "mioku@$target"); then
    deps_hash >"$DEPS_STAMP"
    ok "框架已对齐到 $target"
  else
    warn "框架对齐到 $target 失败（该版本可能尚未发布到 npm），继续使用 $current"
  fi
}

ensure_layout() {
  mkdir -p "$APP_DIR"
  local dir
  for dir in config data logs temp plugins services backup; do
    mkdir -p "$APP_DIR/$dir"
  done
}

ensure_app_entry() {
  if [ ! -f "$APP_DIR/app.ts" ] && [ -f "$TEMPLATE_APP" ]; then
    cp "$TEMPLATE_APP" "$APP_DIR/app.ts"
    log "已补齐缺失的 $APP_DIR/app.ts"
  fi
}

is_mounted() {
  [ -r /proc/self/mountinfo ] || return 0
  awk '{print $5}' /proc/self/mountinfo | grep -qx "$APP_DIR"
}

warn_if_ephemeral() {
  [ "${MIOKU_ALLOW_EPHEMERAL:-0}" = "1" ] && return 0
  is_mounted && return 0
  warn "$APP_DIR 没有挂载到宿主机目录或卷：容器删除后配置、数据与插件都会丢失"
  warn "建议加上：-v \"\$PWD/mioku:$APP_DIR\" -v mioku-packages:$APP_DIR/node_modules"
}

run_wizard() {
  if has_project && [ "${MIOKU_FORCE:-0}" != "1" ]; then
    die "$APP_DIR 已存在项目；如需重新初始化请用 mioku-docker wizard --force（会先自动备份）"
  fi
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    die "首次初始化需要交互式终端，请改用：docker run -it ... 启动；初始化完成后可用 -d 后台运行"
  fi
  if has_project; then
    cmd_backup "$APP_DIR/backup/mioku-prerestore-$(date +%Y%m%d-%H%M%S).tar.gz" >/dev/null
  fi

  local work="/tmp/mioku-scaffold" src
  rm -rf "$work"
  mkdir -p "$work"
  log "未检测到项目，启动创建向导（mioku CLI）..."
  (cd "$work" && mioku) || die "创建向导没有正常结束"

  # 项目可能在子目录里，也可能直接生成在 $work（项目名填 "." 时）
  local found
  found="$(find "$work" -maxdepth 2 -name package.json 2>/dev/null | head -n 1)"
  [ -n "$found" ] || die "向导没有生成 package.json，初始化失败"
  src="$(dirname "$found")"

  log "把项目写入 $APP_DIR ..."
  mkdir -p "$APP_DIR"
  cp -a "$src"/. "$APP_DIR"/
  rm -rf "$work"
  ok "项目已创建"
}

cmd_backup() {
  local dest="${1:-}"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  [ -n "$dest" ] || dest="$APP_DIR/backup/mioku-$stamp.tar.gz"
  mkdir -p "$(dirname "$dest")"

  local items=() name
  for name in app.ts package.json bun.lock config data plugins services; do
    [ -e "$APP_DIR/$name" ] && items+=("$name")
  done
  if [ "${MIOKU_BACKUP_LOGS:-0}" = "1" ] && [ -e "$APP_DIR/logs" ]; then
    items+=(logs)
  fi
  [ "${#items[@]}" -gt 0 ] || die "$APP_DIR 下没有可备份的内容"

  tar -czf "$dest" -C "$APP_DIR" "${items[@]}"
  ok "已备份（不含 node_modules / temp / 日志）到 $dest"
}

cmd_restore() {
  local file="${1:-}"
  [ -n "$file" ] || die "用法：mioku-docker restore <备份文件>"
  [ -f "$file" ] || die "备份文件不存在：$file"
  if has_project && [ "${MIOKU_FORCE:-0}" != "1" ]; then
    warn "目标目录已有项目，恢复会覆盖现有配置与数据"
    die "确认后请加 MIOKU_FORCE=1 重新执行（当前状态会先自动备份）"
  fi
  if has_project; then
    cmd_backup "$APP_DIR/backup/mioku-prerestore-$(date +%Y%m%d-%H%M%S).tar.gz" >/dev/null
    log "已自动备份当前状态到 $APP_DIR/backup/"
  fi

  tar -xzf "$file" -C "$APP_DIR"
  rm -f "$DEPS_STAMP"
  ensure_layout
  ensure_app_entry
  ensure_deps
  ok "恢复完成，启动机器人即可生效"
}

cmd_heal() {
  has_project || die "$APP_DIR 下没有项目，先运行创建向导"
  rm -f "$DEPS_STAMP"
  ensure_deps
  sync_framework_floor
}

cmd_info() {
  local target current supervised plugins tty_note=""
  target="$(image_mioku_version)"
  current="$(installed_mioku_version || echo '未安装')"
  supervised="普通模式"
  case "${MIOKU_SUPERVISED:-}" in
    "" | 0 | false) ;;
    *) supervised="受管模式（MIOKU_SUPERVISED=${MIOKU_SUPERVISED}）" ;;
  esac
  [ -t 0 ] && tty_note="（已分配 TTY，stdin 适配器可直接对话）"

  printf '\n%s== Mioku 容器信息 ==%s\n' "$C_CYAN" "$C_OFF"
  printf '  镜像框架版本   : %s\n' "${target:-未知}"
  printf '  项目框架版本   : %s\n' "$current"
  if [ -f "$APP_DIR/package.json" ]; then
    printf '  项目目录       : %s\n' "$APP_DIR"
  else
    printf '  项目目录       : %s（尚未初始化）\n' "$APP_DIR"
  fi
  printf '  bun / node     : %s / %s\n' "$(bun --version 2>/dev/null || echo '-')" "$(node --version 2>/dev/null || echo '-')"
  printf '  ffmpeg         : %s\n' "$(ffmpeg -version 2>/dev/null | head -n 1 | cut -d' ' -f1-3 || echo '未安装（slim 镜像）')"
  printf '  chromium       : %s\n' "$(chromium --version 2>/dev/null || echo '未安装（slim 镜像）')"
  printf '  运行环境       : %s\n' "$supervised"
  if [ -d "$APP_DIR/node_modules/mioku-service-webui" ]; then
    printf '  WebUI          : http://<宿主地址>:%s  （监听 %s；密钥：config/service/webui/auth.json）\n' "$WEBUI_PORT" "$WEBUI_HOST"
  fi
  if [ -f "$APP_DIR/package.json" ]; then
    plugins="$(node -e '
      const pkg = require(process.argv[1]);
      const mioku = pkg.mioku ?? {};
      const parts = [];
      if (Array.isArray(mioku.plugins)) parts.push(`插件 ${mioku.plugins.join(", ") || "(空)"}`);
      const adapters = Object.keys(mioku.adapters ?? {});
      parts.push(`适配器 ${adapters.join(", ") || "(无)"}`);
      process.stdout.write(parts.join("；"));
    ' "$APP_DIR/package.json" 2>/dev/null || true)"
    [ -n "$plugins" ] && printf '  启用情况       : %s\n' "$plugins"
  fi
  printf '%s\n' "$tty_note"
}

start_bot() {
  warn_if_ephemeral
  ensure_layout
  ensure_app_entry
  ensure_deps
  sync_framework_floor
  ensure_deps

  if [ ! -f "$APP_DIR/app.ts" ]; then
    die "$APP_DIR 下没有 app.ts，项目可能不完整；可用 mioku-docker wizard --force 重新初始化"
  fi

  log "启动 mioku（${APP_DIR}）"
  cd "$APP_DIR"
  exec bun run app.ts
}

main() {
  case "${1:-}" in
    -h | --help | help) usage ;;
    wizard)
      shift
      if [ "${1:-}" = "--force" ]; then MIOKU_FORCE=1; fi
      run_wizard
      start_bot
      ;;
    backup)
      shift
      cmd_backup "${1:-}"
      ;;
    restore)
      shift
      if [ "${1:-}" = "--force" ]; then
        MIOKU_FORCE=1
        shift
      fi
      cmd_restore "${1:-}"
      ;;
    heal) cmd_heal ;;
    info) cmd_info ;;
    shell) shift; exec bash "$@" ;;
    "")
      if has_project; then
        start_bot
      else
        run_wizard
        start_bot
      fi
      ;;
    *) exec "$@" ;;
  esac
}

main "$@"
