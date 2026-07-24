#!/usr/bin/env bash
#
# 见微一键启动脚本
#
# 用法:
#   ./start.sh           构建并启动全部服务（首次自动初始化 .env）
#   ./start.sh start     同上
#   ./start.sh stop      停止并保留数据
#   ./start.sh restart   重启
#   ./start.sh status    查看各服务状态
#   ./start.sh logs      跟踪 worker + web 日志
#   ./start.sh doctor    检查前置依赖（docker / env / creds）
#
set -euo pipefail

# ---- 颜色（仅在 TTY 时启用）--------------------------------------------
if [ -t 1 ]; then
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

info()  { printf '%s[INFO] %s%s\n' "$C_BLUE"   "$1" "$C_RESET"; }
ok()    { printf '%s[OK]   %s%s\n' "$C_GREEN"  "$1" "$C_RESET"; }
warn()  { printf '%s[WARN] %s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
err()   { printf '%s[ERR]  %s%s\n' "$C_RED"    "$1" "$C_RESET"; }
dim()   { printf '%s%s%s\n'        "$C_DIM"    "$1" "$C_RESET"; }

# ---- 路径 ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- 解析 compose 命令 --------------------------------------------------
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif docker-compose version >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "未检测到 Docker Compose。请先安装 Docker Desktop（含 compose 插件）。"
  exit 1
fi

# ---- 工具函数 -----------------------------------------------------------
gen_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

check_docker() {
  if ! docker info >/dev/null 2>&1; then
    err "Docker 守护进程未运行。请启动 Docker 后重试（macOS 打开 Docker Desktop）。"
    exit 1
  fi
}

init_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      ok "已从 .env.example 创建 .env"
    else
      # 兜底：仓库未随附 .env.example 时，仍能量身生成一份最小 .env
      cat > .env <<'ENV'
POSTGRES_PASSWORD=change-me-to-a-strong-password
DATABASE_URL=postgres://monitor:change-me-to-a-strong-password@localhost:54329/monitor
APP_ENCRYPTION_KEY=__GEN__
X_BEARER_TOKEN=
X_BRAVE_MONTHLY_BUDGET_USD=35
BRAVE_SEARCH_API_KEY=
WERSS_BASE_URL=http://localhost:8001
WERSS_ACCESS_KEY=
TRENDRADAR_MCP_URL=http://localhost:3333/mcp
TRENDRADAR_WEBSERVER_PORT=8088
TRENDRADAR_CRON_SCHEDULE=*/30 * * * *
WORKER_POLL_INTERVAL_SECONDS=60
ADMIN_USERNAME=admin
ADMIN_PASSWORD=__GENERATE__
ADMIN_API_TOKEN=__GENERATE__
ENV
      ok "已生成最小 .env（未找到 .env.example 模板）"
    fi
  fi

  # 若 APP_ENCRYPTION_KEY 仍是占位符或为空，自动生成一个真密钥
  if grep -q '^APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key$' .env 2>/dev/null \
     || ! grep -q '^APP_ENCRYPTION_KEY=.\+' .env 2>/dev/null; then
    local k
    k="$(gen_key)"
    if grep -q '^APP_ENCRYPTION_KEY=' .env 2>/dev/null; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$k|" .env
      else
        sed -i '' "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$k|" .env
      fi
    else
      printf 'APP_ENCRYPTION_KEY=%s\n' "$k" >> .env
    fi
    ok "已为 APP_ENCRYPTION_KEY 生成随机 32-byte 密钥"
  fi

  # 若 POSTGRES_PASSWORD 仍是占位符或为空，生成一个随机强密码，
  # 并同步到本地直连示例 DATABASE_URL 的密码段。
  if grep -q '^POSTGRES_PASSWORD=change-me' .env 2>/dev/null \
     || ! grep -q '^POSTGRES_PASSWORD=.\+' .env 2>/dev/null; then
    local p
    p="$(gen_key | tr -dc 'A-Za-z0-9' | head -c 24)"
    if grep -q '^POSTGRES_PASSWORD=' .env 2>/dev/null; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$p|" .env
        sed -i "s|monitor:monitor@localhost|monitor:$p@localhost|" .env
      else
        sed -i '' "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$p|" .env
        sed -i '' "s|monitor:monitor@localhost|monitor:$p@localhost|" .env
      fi
    else
      printf 'POSTGRES_PASSWORD=%s\n' "$p" >> .env
    fi
    ok "已生成随机 Postgres 密码（并同步到本地 DATABASE_URL 示例）"
  fi

  # 网页后台使用独立账号密码；API token 只留给脚本 / CI。
  if ! grep -q '^ADMIN_USERNAME=.\+' .env 2>/dev/null; then
    printf 'ADMIN_USERNAME=admin\n' >> .env
  fi
  if grep -q '^ADMIN_PASSWORD=__GENERATE__$' .env 2>/dev/null \
     || ! grep -q '^ADMIN_PASSWORD=.\+' .env 2>/dev/null; then
    local login_password
    login_password="$(gen_key | tr -dc 'A-Za-z0-9' | head -c 18)"
    if grep -q '^ADMIN_PASSWORD=' .env 2>/dev/null; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$login_password|" .env
      else
        sed -i '' "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$login_password|" .env
      fi
    else
      printf 'ADMIN_PASSWORD=%s\n' "$login_password" >> .env
    fi
    ok "已生成后台登录密码（账号 admin，密码见 .env 的 ADMIN_PASSWORD）"
  fi

  # 若 ADMIN_API_TOKEN 仍是占位符或缺失，生成随机程序令牌。
  if grep -q '^ADMIN_API_TOKEN=__GENERATE__$' .env 2>/dev/null \
     || ! grep -q '^ADMIN_API_TOKEN=' .env 2>/dev/null; then
    local a
    a="$(gen_key | tr -dc 'A-Za-z0-9' | head -c 32)"
    if grep -q '^ADMIN_API_TOKEN=' .env 2>/dev/null; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=$a|" .env
      else
        sed -i '' "s|^ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=$a|" .env
      fi
    else
      printf 'ADMIN_API_TOKEN=%s\n' "$a" >> .env
    fi
    ok "已生成程序 API 令牌 ADMIN_API_TOKEN（仅供脚本 / CI 调用）"
  fi
}

  # 若 ADMIN_SESSION_SECRET 仍是占位符或缺失，生成随机会话密钥。
  if grep -q '^ADMIN_SESSION_SECRET=__GENERATE__$' .env 2>/dev/null \
     || ! grep -q '^ADMIN_SESSION_SECRET=' .env 2>/dev/null; then
    local s
    s="$(openssl rand -hex 32)"
    if grep -q '^ADMIN_SESSION_SECRET=' .env 2>/dev/null; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^ADMIN_SESSION_SECRET=.*|ADMIN_SESSION_SECRET=$s|" .env
      else
        sed -i '' 's|^ADMIN_SESSION_SECRET=.*|ADMIN_SESSION_SECRET=$s|' .env
      fi
    else
      printf 'ADMIN_SESSION_SECRET=%s\n' "$s" >> .env
    fi
    ok "已生成会话签名密钥 ADMIN_SESSION_SECRET"
  fi

# 安全读取 .env 中某个变量的值（兼容含空格/特殊字符的值，不 source 执行文件内容）
# 注意：docker compose 自身会读取项目目录的 .env，无需在本脚本里 export 它。
env_get() {
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

audit_creds() {
  local missing=()
  [ -z "$(env_get X_BEARER_TOKEN)" ]        && missing+=("X_BEARER_TOKEN  (X / Twitter 账号采集)")
  [ -z "$(env_get BRAVE_SEARCH_API_KEY)" ]  && missing+=("BRAVE_SEARCH_API_KEY  (全网关键词搜索)")
  [ -z "$(env_get WERSS_ACCESS_KEY)" ]      && missing+=("WERSS_ACCESS_KEY  (微信公众号采集)")
  if [ ${#missing[@]} -gt 0 ]; then
    warn "以下平台凭据尚未填写（服务会照常启动，但对应采集为空）："
    for m in "${missing[@]}"; do dim "    - $m"; done
    dim "    编辑 .env 后执行 ./start.sh restart 即可生效。"
  else
    ok "所有已知平台凭据均已填写。"
  fi
}

print_help() {
  cat <<'EOF'
见微一键启动脚本

用法:
  ./start.sh           构建并启动全部服务（首次自动初始化 .env）
  ./start.sh start     同上
  ./start.sh stop      停止并保留数据
  ./start.sh restart   重启
  ./start.sh status    查看各服务状态
  ./start.sh logs      跟踪 worker + web 日志
  ./start.sh doctor    检查前置依赖（docker / env / creds）
  ./start.sh -h        显示本帮助
EOF
}

# ---- 子命令 -------------------------------------------------------------
cmd_start() {
  check_docker
  init_env
  info "构建并启动见微全部服务…"
  $DC up -d --build
  ok "容器已创建，迁移与采集将自动就绪。"
  # 等 postgres 接受连接（仅作就绪提示，不阻塞）。
  # 注意：migrate 镜像是 node 基础镜像，不含 pg_isready，故改用 postgres 容器自带的 pg_isready。
  for _i in $(seq 1 30); do
    if $DC exec -T postgres pg_isready -U monitor -d monitor >/dev/null 2>&1; then
      echo "postgres-ready"; break
    fi
    sleep 2
  done
  audit_creds
  echo
  ok "完成！访问以下地址："
  dim "   信息流:      http://localhost:3000"
  dim "   监控后台:    http://localhost:3000/admin"
  dim "   WeRSS 授权:  http://localhost:8001"
  dim "   TrendRadar:  http://localhost:8088（仅本机）"
  dim "   查看日志:    ./start.sh logs"
}

cmd_stop() {
  info "停止服务（保留数据卷）…"
  $DC down
  ok "已停止。PostgreSQL / WeRSS / TrendRadar 数据保留在 docker volume 中。"
}

cmd_restart() {
  $DC down
  cmd_start
}

cmd_status() {
  $DC ps
}

cmd_logs() {
  $DC logs -f --tail=100 worker web
}

cmd_doctor() {
  check_docker
  info "Docker:  $(docker --version 2>/dev/null || echo unknown)"
  info "Compose: $($DC version --short 2>/dev/null || echo unknown)"
  if [ -f .env ]; then ok ".env 存在"; else warn ".env 不存在 —— 执行 start 会自动从 .env.example 创建"; fi
  if $DC config >/dev/null 2>&1; then ok "docker-compose.yml 配置合法"; else err "docker-compose.yml 配置有误，请检查"; fi
  audit_creds
}

main() {
  local cmd="${1:-start}"
  case "$cmd" in
    start|up)        cmd_start ;;
    stop|down)       cmd_stop ;;
    restart)         cmd_restart ;;
    status|ps)       cmd_status ;;
    logs)            cmd_logs ;;
    doctor)          cmd_doctor ;;
    -h|--help|help)  print_help ;;
    *) err "未知命令: $cmd"; print_help; exit 1 ;;
  esac
}

main "$@"
