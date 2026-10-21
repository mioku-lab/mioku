#!/usr/bin/env bash
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DOCKER_DIR")"
IMAGE="${IMAGE:-mioku}"

read_local_version() {
  local pkg="$REPO_DIR/packages/mioku/package.json"
  [ -f "$pkg" ] || return 0
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1
}

VERSION="${VERSION:-$(read_local_version)}"
VERSION="${VERSION:-latest}"
PLATFORM="${PLATFORM:-}"
PUSH=0
FLAVOR="all"

while [ $# -gt 0 ]; do
  case "$1" in
    full | slim | all) FLAVOR="$1" ;;
    --push) PUSH=1 ;;
    --platform) shift; PLATFORM="${1:-}" ;;
    --platform=*) PLATFORM="${1#*=}" ;;
    --image) shift; IMAGE="${1:-}" ;;
    --image=*) IMAGE="${1#*=}" ;;
    -h | --help)
      echo "用法: $0 [full|slim|all] [--push] [--platform <平台列表>] [--image <镜像名>]"
      echo "环境变量: IMAGE VERSION PLATFORM BUN_IMAGE NODE_IMAGE"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
  shift
done

echo "框架版本: $VERSION"
echo "镜像名称: $IMAGE"
echo "目标平台: ${PLATFORM:-本机}"
echo "构建目标: $FLAVOR"
echo

build_one() {
  local target="$1"
  shift
  local args=(build --target "$target" -f "$DOCKER_DIR/Dockerfile" --build-arg "MIOKU_VERSION=$VERSION")
  if [ -n "${BUN_IMAGE:-}" ]; then args+=(--build-arg "BUN_IMAGE=$BUN_IMAGE"); fi
  if [ -n "${NODE_IMAGE:-}" ]; then args+=(--build-arg "NODE_IMAGE=$NODE_IMAGE"); fi
  if [ -n "$PLATFORM" ]; then args+=(--platform "$PLATFORM"); fi
  if [ "$PUSH" = "1" ]; then args+=(--push); fi
  local tag
  for tag in "$@"; do args+=(-t "$tag"); done

  echo "> $target -> $*"
  if [ "$PUSH" = "1" ] || [ -n "$PLATFORM" ]; then
    docker buildx "${args[@]}" "$DOCKER_DIR"
  else
    docker "${args[@]}" "$DOCKER_DIR"
  fi
}

image_tags() {
  local name
  local -a names=()
  IFS=',' read -r -a names <<<"$IMAGE"
  for name in "${names[@]}"; do
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    if [ "$1" = "full" ]; then
      printf '%s\n' "$name:$VERSION" "$name:latest"
    else
      printf '%s\n' "$name:$VERSION-slim" "$name:slim"
    fi
  done
}

build_flavor() {
  local -a tags=()
  local tag
  while IFS= read -r tag; do
    [ -n "$tag" ] && tags+=("$tag")
  done < <(image_tags "$1")
  if [ "${#tags[@]}" -eq 0 ]; then
    echo "镜像名为空，跳过 $1" >&2
    return 0
  fi
  build_one "$1" "${tags[@]}"
}

if [ "$FLAVOR" = "full" ] || [ "$FLAVOR" = "all" ]; then
  build_flavor full
fi

if [ "$FLAVOR" = "slim" ] || [ "$FLAVOR" = "all" ]; then
  build_flavor slim
fi

echo
echo "完成。"
