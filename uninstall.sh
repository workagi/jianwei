#!/usr/bin/env bash
#
# 见微一键卸载脚本
#
# 用法:
#   ./uninstall.sh          交互式卸载（逐步确认）
#   ./uninstall.sh --yes     跳过确认，删除全部（仅限本项目资源与项目目录）
#   ./uninstall.sh --clean   仅停止并删除容器和数据卷，保留项目文件和镜像
#   ./uninstall.sh --dry-run 只显示将删除的资源，不执行删除
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

YES=false
CLEAN_ONLY=false
DRY_RUN=false
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$SCRIPT_DIR")}"

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
    --clean|-c) CLEAN_ONLY=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "用法: ./uninstall.sh [--yes|-y] [--clean|-c] [--dry-run]"
      echo ""
      echo "  （无参数）  交互式逐步确认"
      echo "  --yes -y    全部删除，不确认（仅限本项目容器、网络、卷、镜像和目录）"
      echo "  --clean -c  只删容器和数据卷，保留项目文件和镜像"
      echo "  --dry-run   只显示将删除的资源，不执行删除"
      exit 0
      ;;
  esac
done

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; RESET='\033[0m'
info()  { echo -e "${GREEN}[INFO]${RESET} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()   { echo -e "${RED}[ERR]${RESET}  $1"; }
ok()    { echo -e "${GREEN}[OK]${RESET}   $1"; }

confirm() {
  if $DRY_RUN; then return 1; fi
  if $YES; then return 0; fi
  local prompt="$1"
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

project_container_ids() {
  docker container ls -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null
}

project_volume_names() {
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null
}

project_network_names() {
  docker network ls -q \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null
}

project_image_ids() {
  {
    # Compose-built images carry the project label. Images currently attached
    # to a project container are included as a fallback for older Compose.
    docker image ls -q \
      --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null
    project_container_ids | while IFS= read -r container_id; do
      [ -n "$container_id" ] || continue
      docker container inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true
    done
  } | awk 'NF && !seen[$0]++'
}

show_named_resources() {
  local kind="$1"
  local values="$2"
  if [ -z "$values" ]; then
    echo "  （未找到）"
    return
  fi
  while IFS= read -r value; do
    [ -n "$value" ] && printf '  %s\n' "$value"
  done <<< "$values"
  info "以上${kind}均通过 com.docker.compose.project=$PROJECT_NAME 精确识别"
}

if $DRY_RUN; then
  info "只读预览模式：不会删除任何资源或文件"
fi

CONTAINER_IDS="$(project_container_ids)"
VOLUME_NAMES="$(project_volume_names)"
NETWORK_IDS="$(project_network_names)"
IMAGE_IDS="$(project_image_ids)"

# ---- Step 1: Stop & remove containers + networks -----------------------
echo ""
info "Step 1/5: 停止并删除容器和网络 ..."
show_named_resources "容器" "$CONTAINER_IDS"
show_named_resources "网络" "$NETWORK_IDS"
if ! $DRY_RUN; then
  if [ -n "$CONTAINER_IDS" ]; then
    while IFS= read -r container_id; do
      [ -n "$container_id" ] && docker container rm -f "$container_id" 2>/dev/null || true
    done <<< "$CONTAINER_IDS"
  fi
  if [ -n "$NETWORK_IDS" ]; then
    while IFS= read -r network_id; do
      [ -n "$network_id" ] && docker network rm "$network_id" 2>/dev/null || true
    done <<< "$NETWORK_IDS"
  fi
  ok "本项目容器和网络已清理"
fi

# ---- Step 2: Remove volumes (DATA LOSS) --------------------------------
echo ""
echo "以下 Docker 数据卷将被删除："
show_named_resources "数据卷" "$VOLUME_NAMES"

if $DRY_RUN; then
  info "预览：跳过数据卷删除"
elif confirm "删除以上数据卷？这将永久删除所有监控数据和配置！"; then
  while IFS= read -r volume_name; do
    [ -n "$volume_name" ] && docker volume rm "$volume_name" 2>/dev/null || true
  done <<< "$VOLUME_NAMES"
  ok "数据卷已删除"
else
  info "跳过数据卷删除"
fi

# ---- Step 3: Remove images ---------------------------------------------
if $CLEAN_ONLY; then
  info "Step 3/5: 跳过（--clean 模式不删镜像）"
else
  echo ""
  echo "以下本项目 Docker 镜像 ID 将被删除："
  show_named_resources "镜像" "$IMAGE_IDS"

  # 只删除带 Compose project label 或曾被本项目容器引用的镜像。
  # 被其他容器使用的共享镜像会由 Docker 拒绝删除。
  if $DRY_RUN; then
    info "预览：跳过镜像删除"
  elif confirm "删除以上镜像？"; then
    while IFS= read -r image_id; do
      [ -n "$image_id" ] && docker image rm "$image_id" 2>/dev/null || true
    done <<< "$IMAGE_IDS"
    ok "镜像已删除"
  else
    info "跳过镜像删除"
  fi
fi

# ---- Step 4: Keep global build cache -----------------------------------
# Docker BuildKit cache has no reliable Compose-project ownership label.
# A global `docker builder prune` can evict cache belonging to unrelated
# projects, so the project uninstaller deliberately leaves it untouched.
info "Step 4/5: 保留全局 Docker 构建缓存（避免影响其他项目）"

# ---- Step 5: Remove project directory ----------------------------------
if $DRY_RUN; then
  info "Step 5/5: 预览将保留项目目录 $SCRIPT_DIR"
elif $CLEAN_ONLY; then
  info "Step 5/5: 跳过（--clean 模式不删项目文件）"
else
  echo ""
  warn "最后一步：删除整个项目目录"
  echo "  路径: $SCRIPT_DIR"
  if confirm "确认删除项目目录及其所有文件？"; then
    cd "$SCRIPT_DIR/.." || true
    rm -rf "$SCRIPT_DIR"
    ok "项目目录已删除"
    echo ""
    info "见微已完全卸载。"
  else
    info "跳过项目目录删除"
    echo ""
    info "见微已部分卸载（项目文件保留在 $SCRIPT_DIR）"
  fi
fi
