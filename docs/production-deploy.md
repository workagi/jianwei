# 见微线上部署说明

这份文档用于把本地见微迁到一台公网服务器。核心原则：公网只暴露 HTTPS 入口，其他数据库、WeRSS、TrendRadar、MCP、refresh 服务全部留在 Docker 内网。

## 1. 服务器准备

建议配置：

- 最低：2C / 4G / 40G 磁盘
- 更稳：2C-4C / 8G，尤其开启模型摘要、公众号全文理解或高频采集时
- 系统：Ubuntu 22.04/24.04 或 Debian 12
- 域名：准备一个域名并把 A 记录解析到服务器公网 IP

4 核 / 4GB 可以运行完整服务并做小规模监控；如果同时开启模型摘要、公众号全文回填或多个高频任务，建议 8GB 内存。没有 Swap 的 4GB 主机只建议用于小规模测试，长期公网运行前应增加 Swap 或升级内存。

服务器只需要放行：

- `80/tcp`
- `443/tcp`
- `22/tcp`，建议仅限你的固定 IP

不要开放 Postgres、WeRSS、TrendRadar、MCP、refresh 端口。

## 2. 上传代码

在服务器上：

```bash
git clone https://github.com/workagi/jianwei.git
cd jianwei
```

如果不是用 Git，也可以把整个项目目录上传到服务器。

## 3. 配置生产环境变量

```bash
cp .env.production.example .env.production
```

以下各项都必须填写；缺失时 Compose 会在启动前直接报错，避免 Caddy
因为空证书邮箱进入反复重启：

```dotenv
JIANWEI_DOMAIN=你的域名
ACME_EMAIL=你的邮箱
POSTGRES_PASSWORD=强随机密码
APP_ENCRYPTION_KEY=32字节base64随机值
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin@123
ADMIN_API_TOKEN=强随机令牌
ADMIN_SESSION_SECRET=独立的32字节以上随机值
TRENDRADAR_REFRESH_TOKEN=强随机令牌
```

推荐生成方式：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

首次登录固定使用 `admin / admin@123`，便于新用户直接进入面板；请在首次
登录后立即到后台修改密码。`ADMIN_SESSION_SECRET` 只在服务内部用于签发
登录会话，用户不需要输入；它必须与 `ADMIN_PASSWORD`、`ADMIN_API_TOKEN`
使用不同的随机值。缺失时生产 Compose 会拒绝启动，避免出现“页面正常但
无法登录”的半可用状态。

注意：后台保存的模型、搜索、X 与 WeRSS API 密钥会用 `APP_ENCRYPTION_KEY`
进行 AES-256-GCM 加密。后续不要直接更换该值，否则已有凭据无法解密；迁移服务器时必须连同它安全迁移。

`DOCUMENT_ANALYSIS_CLAIM_LEASE_MINUTES` 默认是 `30`。它用于避免多个 Worker
同时为同一篇文章重复调用模型；通常无需调整。若单批模型处理稳定超过 30 分钟，
应先缩小采集批次，再按实际最长耗时提高该值（允许范围 5–120 分钟）。

## 4. 启动生产服务

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml up -d --build
```

查看状态：

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml ps
```

查看日志：

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml logs -f web worker
```

启动后访问：

```text
https://你的域名
https://你的域名/admin
https://你的域名/admin/connectors
```

后台登录使用 `.env.production` 里的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
`ADMIN_API_TOKEN` 只供脚本调用写接口，不能用于网页登录；三项凭据缺失时系统会拒绝访问，不会降级为无密码模式。
首次登录后立即在后台修改管理密码；不要把 `.env.production`、API Token 或加密密钥提交到 Git。

## 5. WeRSS 授权方式

生产 compose 不把 WeRSS 暴露到公网。需要扫码授权时，在你本机开 SSH 隧道：

```bash
ssh -L 8001:127.0.0.1:8001 <user>@<server>
```

然后在你本机浏览器访问：

```text
http://localhost:8001
```

授权完成后关闭 SSH 隧道即可。

如果服务器无法通过 `127.0.0.1:8001` 访问 WeRSS，是因为生产 compose 默认没有对宿主机暴露端口。`docker compose port` 只能查询已有映射，不能创建映射。需要扫码时，在项目目录临时创建 override：

```bash
cat > /tmp/jianwei-werss-tunnel.yml <<'EOF'
services:
  werss:
    ports:
      - "127.0.0.1:8001:8001"
EOF

docker compose --env-file .env.production -p jianwei \
  -f docker-compose.prod.yml -f /tmp/jianwei-werss-tunnel.yml up -d werss

ssh -L 8001:127.0.0.1:8001 <user>@<server>
```

本机浏览器访问 `http://localhost:8001` 完成授权后，停止临时映射并删除文件：

```bash
docker compose --env-file .env.production -p jianwei \
  -f docker-compose.prod.yml -f /tmp/jianwei-werss-tunnel.yml stop werss
rm -f /tmp/jianwei-werss-tunnel.yml
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml up -d werss
```

映射只绑定服务器回环地址，不要把 WeRSS 裸露到公网。

### 可选：连接自建 ZLZChat

ZLZChat 不随生产 Compose 安装。若已经单独部署，可在 `.env.production` 或后台「平台连接」配置：

```env
ZLZCHAT_BASE_URL=http://your-private-zlzchat:805
ZLZCHAT_API_KEY=replace-with-your-key
ZLZCHAT_ALLOWED_ORIGINS=http://your-private-zlzchat:805
```

该地址必须同时能被 `web` 和 `worker` 容器访问。私网实例还必须把精确 origin 写入部署级 `ZLZCHAT_ALLOWED_ORIGINS`；这是 SSRF 防护白名单，不能省略，也不要配置比实际服务更宽的地址范围。优先使用同一私有 Docker 网络、内网 IP 或带 HTTPS 的私有入口，不要暴露后台管理端口，也不要连接公开演示站。配置完成后，在单个公众号监控中手动选择 ZLZChat；现有 WeRSS 监控不会被自动迁移。完整说明见 [ZLZChat 备选通道](zlzchat-integration.md)。

## 6. 热榜 / RSS 来源管理

线上也可以在后台管理：

```text
/admin/connectors → 热榜 / RSS 来源
```

- `保存来源`：保存配置，等 TrendRadar 下一轮 cron 采集
- `保存并立即刷新`：保存后通过内部 `trendradar-refresh` 侧车触发一次采集

`trendradar-refresh` 不暴露公网端口，也不挂 Docker socket，只能在 Docker 内网里执行固定采集命令。

## 7. 备份

必须备份五类数据：

1. Postgres：监控任务、文章、收藏、运行状态、后台配置
2. WeRSS volume：公众号授权、订阅信息
3. 增强公众号采集器 volume（启用时）：扫码登录与会话信息
4. TrendRadar output volume：热榜/RSS 历史
5. `infra/trendradar/config`：热榜/RSS 来源配置

推荐每晚执行一次：

```bash
# PostgreSQL：生成 custom-format dump，并在容器内验证可恢复性
./scripts/backup-db.sh backups

docker run --rm \
  -v jianwei_werss-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/werss-data-$(date +%F).tgz -C /data .

# 仅在启用了 wechat-fallback profile 时需要
docker run --rm \
  -v jianwei_wechat-fallback-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/wechat-fallback-data-$(date +%F).tgz -C /data .

docker run --rm \
  -v jianwei_trendradar-output:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/trendradar-output-$(date +%F).tgz -C /data .

tar czf backups/trendradar-config-$(date +%F).tgz infra/trendradar/config
```

数据库恢复前先确认 `.env.production` 和 `APP_ENCRYPTION_KEY` 已恢复到原值，然后执行：

```bash
./scripts/restore-db.sh backups/jianwei-YYYYMMDDTHHMMSSZ.dump
```

恢复脚本会临时停止同一 Compose 项目中的 web 和 worker，使用 `pg_restore`
在单个事务中替换数据库内容，完成后再启动应用。至少每月在一台临时服务器上
做一次真实恢复演练；只检查备份文件存在并不能证明它可以恢复。
脚本默认选择 Compose 项目 `jianwei`；如果部署时使用了其他 `-p` 名称，
执行备份或恢复前设置 `JIANWEI_COMPOSE_PROJECT=你的项目名`。

如果 compose 项目名不是 `jianwei`，volume 名会不同。用下面命令确认真实名称：

```bash
docker volume ls | grep -E 'werss|trendradar|postgres|monitor'
```

## 8. 升级

```bash
git pull
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml up -d --build
```

迁移服务 `migrate` 会在启动时自动跑数据库迁移和 seed。

## 9. 常见问题

### 证书没有下来

检查：

- 域名 A 记录是否指向服务器
- 服务器安全组是否放行 80/443
- 服务器上是否已有 Nginx/Apache 占用 80/443

### 后台保存热榜/RSS 失败

检查 web 容器是否能写配置：

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml exec -T web \
  sh -lc 'test -w /app/trendradar-config/config.yaml && echo writable || echo not-writable'
```

### 信息流没有立刻更新

`保存并立即刷新` 会触发 TrendRadar 采集；见微的 `worker` 还会按自己的轮询周期把 TrendRadar 输出导入 Postgres。默认最多等几十秒到一分钟。

### WeRSS 需要重新扫码

用 SSH 隧道访问 WeRSS 后台重新授权。务必备份 `werss-data` volume，否则重建服务器时授权会丢。

### Worker 日志出现 `402/404 Message task not found or has been deactivated`

这通常表示 WeRSS 中原来的订阅任务已被删除、停用或授权状态失效，不代表 Jianwei 容器启动失败。处理顺序：

1. 通过 SSH 隧道打开 WeRSS 后台。
2. 重新扫码授权微信账号。
3. 确认公众号订阅仍存在；必要时删除旧订阅后重新添加。
4. 回到 Jianwei 后台检查对应监控，等待下一轮采集。

如果 Worker 和 `/api/health` 仍为 healthy，但只有某个公众号出现该错误，优先按上述方式修复该订阅，不要重装数据库。

## 10. 全新服务器验收清单

首次在没有 Jianwei 容器、镜像和数据卷的服务器上部署，建议按下面顺序验收：

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml config -q
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml up -d --build --wait
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml ps
curl -fsS https://你的域名/api/health
```

验收标准：

- `postgres`、`web`、`worker`、`werss`、`trendradar`、`trendradar-mcp`、`trendradar-refresh` 均已启动。
- `/api/health` 返回 `ok: true`，且 `database`、`worker` 均为 `ok`。多 Worker 部署会汇总所有实例；只要有实例停止心跳，`worker` 会变为 `delayed` 并返回 HTTP 503，不会被另一台正常实例掩盖。
- 能打开 `/admin` 并登录。
- WeRSS 通过 SSH 隧道完成扫码后，能订阅一个公众号。
- 添加一个监控后，能在首页看到首次采集结果。
- `docker compose logs web worker` 没有持续增长的启动错误。

这套验收证明的是“全新环境可以启动和完成主链路”，不替代真实平台账号的长期稳定性测试。
