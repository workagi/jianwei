#!/usr/bin/env bash
#
# 见微一键卸载脚本
#
# 用法:
#   ./uninstall.sh          交互式卸载（逐步确认）
#   ./uninstall.sh --yes     跳过确认，删除全部（容器+网络+数据卷+所有镜像+项目目录）
#   ./uninstall.sh --clean   仅停止并删除容器和数据卷，保留项目文件和镜像
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

YES=false
CLEAN_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
    --clean|-c) CLEAN_ONLY=true ;;
    --help|-h)
      echo "用法: ./uninstall.sh [--yes|-y] [--clean|-c]"
      echo ""
      echo "  （无参数）  交互式逐步确认"
      echo "  --yes -y    全部删除，不确认（容器+网络+数据卷+镜像+项目目录）"
      echo "  --clean -c  只删容器和数据卷，保留项目文件和镜像"
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
  if $YES; then return 0; fi
  local prompt="$1"
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# 匹配本项目相关的所有 Docker 资源
VOL_PATTERN='jianwei|monitor-postgres|werss-data|trendradar-output|wechat-fallback-data|worker-heartbeat'
IMG_PATTERN='^jianwei|^ghcr.*we-mp-rss|^wantcat/trendradar|^tmwgsicp/wechat-download'

# ---- Step 1: Stop & remove containers + networks -----------------------
echo ""
info "Step 1/5: 停止并删除容器和网络 ..."
docker compose down --remove-orphans --volumes 2>/dev/null || true
docker compose -f docker-compose.prod.yml down --remove-orphans --volumes 2>/dev/null || true
# 清理未被 compose 管理的残留网络
docker network ls --format '{{.Name}}' 2>/dev/null | grep -E 'jianwei' | while read -r net; do
  docker network rm "$net" 2>/dev/null || true
done
ok "容器和网络已清理"

# ---- Step 2: Remove volumes (DATA LOSS) --------------------------------
echo ""
echo "以下 Docker 数据卷将被删除："
docker volume ls --format '  {{.Name}}' 2>/dev/null | grep -E "$VOL_PATTERN" || echo "  （未找到）"

if confirm "删除以上数据卷？这将永久删除所有监控数据和配置！"; then
  docker volume ls -q 2>/dev/null | grep -E "$VOL_PATTERN" | while read -r vol; do
    docker volume rm "$vol" 2>/dev/null || true
  done
  ok "数据卷已删除"
else
  info "跳过数据卷删除"
fi

# ---- Step 3: Remove images ---------------------------------------------
if $CLEAN_ONLY; then
  info "Step 3/5: 跳过（--clean 模式不删镜像）"
else
  echo ""
  echo "以下 Docker 镜像将被删除："
  docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' 2>/dev/null | grep -E "$IMG_PATTERN" || echo "  （未找到）"

  # 只删除本项目构建或拉取的镜像。如果镜像被其他项目共享，
# docker rmi 会因为"image is being used"而自动跳过，不会误删。
if confirm "删除以上镜像？"; then
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E "$IMG_PATTERN" | while read -r img; do
      docker rmi "$img" 2>/dev/null || true
    done
    ok "镜像已删除"
  else
    info "跳过镜像删除"
  fi
fi

# ---- Step 4: Prune build cache -----------------------------------------
if $CLEAN_ONLY; then
  info "Step 4/5: 跳过（--clean 模式不清理构建缓存）"
else
  echo ""
  if confirm "清理 Docker 构建缓存？"; then
    docker builder prune -f 2>/dev/null || true
    ok "构建缓存已清理"
  else
    info "跳过构建缓存清理"
  fi
fi

# ---- Step 5: Remove project directory ----------------------------------
if $CLEAN_ONLY; then
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
