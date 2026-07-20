# 见微线上部署说明

这份文档用于把本地见微迁到一台公网服务器。核心原则：公网只暴露 HTTPS 入口，其他数据库、WeRSS、TrendRadar、MCP、refresh 服务全部留在 Docker 内网。

## 1. 服务器准备

建议配置：

- 最低：2C / 4G / 40G 磁盘
- 更稳：2C-4C / 8G，尤其开启模型摘要、公众号全文理解或高频采集时
- 系统：Ubuntu 22.04/24.04 或 Debian 12
- 域名：准备一个域名并把 A 记录解析到服务器公网 IP

服务器只需要放行：

- `80/tcp`
- `443/tcp`
- `22/tcp`，建议仅限你的固定 IP

不要开放 Postgres、WeRSS、TrendRadar、MCP、refresh 端口。

## 2. 上传代码

在服务器上：

```bash
git clone https://github.com/skymao2021/jianwei.git
cd jianwei
```

如果不是用 Git，也可以把整个项目目录上传到服务器。

## 3. 配置生产环境变量

```bash
cp .env.production.example .env.production
```

至少改这些：

```dotenv
JIANWEI_DOMAIN=你的域名
ACME_EMAIL=你的邮箱
POSTGRES_PASSWORD=强随机密码
APP_ENCRYPTION_KEY=32字节base64随机值
ADMIN_USERNAME=admin
ADMIN_PASSWORD=强登录密码
ADMIN_API_TOKEN=强随机令牌
TRENDRADAR_REFRESH_TOKEN=强随机令牌
```

推荐生成方式：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

注意：后台保存的模型、搜索、X 与 WeRSS API 密钥会用 `APP_ENCRYPTION_KEY`
进行 AES-256-GCM 加密。后续不要直接更换该值，否则已有凭据无法解密；迁移服务器时必须连同它安全迁移。

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
`ADMIN_API_TOKEN` 只用于脚本或 CI 调用受保护的写接口。

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

如果服务器无法通过 `127.0.0.1:8001` 访问 WeRSS，是因为生产 compose 默认没有对宿主机暴露端口。可临时执行：

```bash
docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml port werss 8001
```

更推荐的方式是临时加一个只绑定 `127.0.0.1` 的 override 文件，用完删掉；不要把 WeRSS 裸露到公网。

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
mkdir -p backups

docker compose --env-file .env.production -p jianwei -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U monitor -d monitor > backups/postgres-$(date +%F).sql

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
