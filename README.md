# SignalDeck 信息监控台

统一订阅公开 X/Twitter 账号、微信公众号与全网关键词，并在一个时间线中阅读、搜索和管理采集状态。

架构采用"复用优先"：TrendRadar 负责成熟的平台热榜、RSS、关键词过滤、调度、AI 分析和推送；SignalDeck 只补任意账号采集、全网搜索、动态后台和统一阅读界面。详见 [TrendRadar 集成决策](docs/architecture-trendradar.md)。

## 快速上手

最快的方式是直接使用仓库自带的一键脚本（首次运行会自动复制 `.env.example` → `.env` 并生成 `APP_ENCRYPTION_KEY`）：

```bash
./start.sh          # 构建并启动全部服务
```

脚本支持子命令：`start`（默认）/`stop`/`restart`/`status`/`logs`/`doctor`。例如：

```bash
./start.sh doctor   # 检查 Docker 与凭据配置是否就绪
./start.sh logs     # 实时跟踪 worker + web 日志
./start.sh stop     # 停止并保留数据
```

启动成功后访问：

- 信息流: <http://localhost:3000>
- 监控后台: <http://localhost:3000/admin>
- WeRSS 授权后台: <http://localhost:8001>
- TrendRadar 报告页: <http://localhost:8088>（仅本机）

### 平台凭据速查

`start.sh` 会自动初始化 `.env` 并生成 `APP_ENCRYPTION_KEY`，但你仍需按要订阅的平台填写对应凭据——留空不会阻断启动，只是对应采集为空：

| 平台 | 需填写的变量 | 去哪获取 |
| --- | --- | --- |
| X / Twitter 账号 | `X_BEARER_TOKEN` | <https://developer.x.com> 申请的 Bearer Token |
| 全网关键词 | `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` | Brave / Tavily / Serper 至少配置一个；添加监控时可选择服务商 |
| 微信公众号 | `WERSS_ACCESS_KEY` | WeRSS 后台（<http://localhost:8001>）的 Access Key |
| 预算上限（可选） | `X_BRAVE_MONTHLY_BUDGET_USD` | 留空=不限；填数字（USD）对 X+Brave 合并封顶 |

> 首次使用微信公众号采集时，还需在 WeRSS 后台 <http://localhost:8001> 扫码授权目标公众号。

### 访问控制（建议开启）

默认 `start.sh` 会在首次启动时自动生成一个随机 `ADMIN_API_TOKEN` 并写入 `.env`。一旦 `.env` 中存在该变量，**所有写操作**（创建 / 编辑 / 删除监控、校验配置）与**监控后台 `/admin`** 都需携带它：

- 写操作 API：请求头加 `Authorization: Bearer <ADMIN_API_TOKEN>`（缺失或错误返回 `401`）。
- 监控后台 `/admin`：打开后要求输入令牌；输入正确后写入 httpOnly Cookie，之后免重复输入（右上角"退出登录"可清除）。

阅读信息流（首页与 `GET /api/monitors`）始终公开，无需令牌。

> 若 `.env` 中删掉或留空 `ADMIN_API_TOKEN`，则关闭鉴权（适合仅本机 / 内网使用）。**任何暴露到公网的部署都应保留该令牌。**

## Docker 运行（推荐部署方式）

`docker compose up -d --build` 一条命令即可拉起全部组件，**无需手动建表或跑迁移脚本**。

> 部署到公网服务器时，不要直接使用本地 compose 暴露端口。请使用生产 compose：`docker-compose.prod.yml`，它只公开 Caddy 的 80/443，其他服务全部留在 Docker 内网。完整步骤见 [线上部署说明](docs/production-deploy.md)。

1. 复制环境变量：

   ```bash
   cp .env.example .env
   ```

2. 至少填写需要启用的平台凭据（`APP_ENCRYPTION_KEY` 必填，其余按订阅的平台填）：

   ```dotenv
   APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key
   X_BEARER_TOKEN=
   BRAVE_SEARCH_API_KEY=
   TAVILY_API_KEY=
   SERPER_API_KEY=
   WERSS_ACCESS_KEY=
   ```

3. 构建并启动：

   ```bash
   docker compose up -d --build
   ```

4. 打开：

   - SignalDeck 信息流: <http://localhost:3000>
   - 监控后台: <http://localhost:3000/admin>
   - WeRSS 授权后台: <http://localhost:8001>
   - TrendRadar 报告页: <http://localhost:8088>（仅本机）

5. 首次使用微信公众号采集时，在 WeRSS 后台扫码授权。

停止服务但保留数据：

```bash
docker compose down
```

PostgreSQL、WeRSS 与 TrendRadar 的输出均保存在具名 volumes 中（`docker volume ls` 可见 `*-monitor-postgres` / `*-werss-data` / `*-trendradar-output`）。

### 服务一览

| 服务 | 镜像 / 构建 | 作用 | 端口（本机） |
| --- | --- | --- | --- |
| `postgres` | `postgres:17-alpine` | 归一化存储（items / item_matches / monitors / collection_runs） | `54329` |
| `migrate` | 本仓库 `tools` 阶段 | **一次性**跑 `drizzle-kit migrate` 建表/加枚举，完成后退出 | — |
| `web` | 本仓库 Next.js standalone | 信息流 + 后台 UI + `/api/trendradar/latest` | `3000` |
| `worker` | 本仓库 `tools` 阶段 | **常驻采集**：拉到期监控 → 调适配器 → 入库 | — |
| `werss` | `ghcr.io/rachelos/we-mp-rss` | 微信公众号 RSS 侧车，扫码授权后台 | `8001` |
| `trendradar` | `wantcat/trendradar` | 平台热榜 / RSS / 关键词过滤 / 调度 / AI（复用，不重造） | `8088` |
| `trendradar-mcp` | `wantcat/trendradar-mcp` | TrendRadar 的 MCP 查询服务，供 SignalDeck 拉热榜/RSS | `3333` |
| `trendradar-refresh` | `wantcat/trendradar` | 内网刷新侧车：后台“保存并立即刷新”时触发一次 TrendRadar 采集 | — |

生产模式额外包含 `caddy` 作为唯一公网入口（80/443），详见 [线上部署说明](docs/production-deploy.md)。

> `migrate` 与 `worker` 复用同一个 `tools` Docker 阶段（含完整依赖树与 `tsx` / `drizzle-kit`），分别以 `pnpm db:migrate` / `pnpm worker` 作为命令启动。

### 启动顺序与依赖

`docker compose` 会按依赖依次启动，保证数据链路就绪：

```
postgres (healthy)
   └─ migrate (service_completed_successfully)   ← 自动建表/加枚举
         ├─ web     (依赖 migrate 完成 + postgres healthy)
         └─ worker  (依赖 migrate 完成 + postgres healthy)
werss / trendradar / trendradar-mcp 以 service_started 并行拉起
```

`web` 与 `worker` 都会等 `migrate` 成功完成后才启动；迁移失败会直接阻断二者，避免无表可读写。

### 采集如何工作

`worker` 是一个**常驻轮询进程**：启动后以 `WORKER_POLL_INTERVAL_SECONDS`（默认 60s）为间隔循环，每轮选出 `enabled` 且 `next_run_at` 到期的监控，按平台分发；收到 `SIGTERM`（如 `docker stop`）会跑完当前轮后优雅退出。

- **trendradar**：通过 `trendradar-mcp` 侧车取热榜 + RSS，归一化后幂等入库（`items` + `item_matches`），并记录 `collection_runs`。
- **x / wechat / web_search**：直连连接器均已打通（X 用官方 v2、WeChat 走 WeRSS、全网搜索可选 Brave / Tavily / Serper）。添加全网关键词监控时选择 provider；旧任务默认 Brave。x / web_search 在采集前会校验 `X_BRAVE_MONTHLY_BUDGET_USD` 月度预算，超额则标记 `BUDGET_EXHAUSTED` 并跳过；用量写入 `usage_ledger`。

信息流 `/` 与后台 `/admin` 经 `reader-data` 读取 PostgreSQL；未配置 `DATABASE_URL` 或查询失败时回退演示数据，界面不会空白。

### 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（必填） | — |
| `APP_ENCRYPTION_KEY` | 凭据静态加密密钥（32-byte base64） | — |
| `X_BEARER_TOKEN` | X 官方 API Bearer Token | 空 |
| `BRAVE_SEARCH_API_KEY` | Brave Search API Key | 空 |
| `TAVILY_API_KEY` | Tavily Search API Key | 空 |
| `SERPER_API_KEY` | Serper / Google Search API Key | 空 |
| `X_BRAVE_MONTHLY_BUDGET_USD` | X+Brave 合并月度预算上限（USD），空=不限 | 空 |
| `WERSS_BASE_URL` | WeRSS 侧车地址 | `http://localhost:8001` |
| `WERSS_ACCESS_KEY` | WeRSS Access Key（推荐 `AK-SK key:secret`；兼容旧版 Bearer AK） | 空 |
| `TRENDRADAR_MCP_URL` | TrendRadar MCP 侧车地址 | `http://localhost:3333/mcp` |
| `TRENDRADAR_CRON_SCHEDULE` | TrendRadar 自身调度周期 | `*/30 * * * *` |
| `WORKER_POLL_INTERVAL_SECONDS` | worker 轮询间隔（秒） | `60` |
| `SUMMARY_PROVIDER` | 模型 API provider：`deepseek` / `volcengine` / `openai_compatible` / `openai` / `claude` | 空（关闭） |
| `SUMMARY_BASE_URL` | OpenAI-compatible Base URL；DeepSeek/火山方舟有后台预设，自定义服务必填 | 空 |
| `SUMMARY_API_KEY` | 模型 API 统一 API Key；后台填写后写入数据库并由 worker 下一轮读取 | 空 |
| `SUMMARY_MODEL` | 模型名；火山方舟通常填推理接入点 ID / 模型 ID | 空 |
| `SUMMARY_SKIP_PLATFORMS` | 跳过模型 API 内容理解的平台，默认跳过微信，后台勾选后清空 | `wechat` |

### 健康检查与重启

- `postgres` 内置 `pg_isready` 健康检查；`werss` 内置端口探测。
- 所有服务 `restart: unless-stopped`，进程退出后由 Docker 自动拉起。
- 查看实时日志：`docker compose logs -f worker`（采集）/`docker compose logs -f web`。
- 手动重新触发迁移：`docker compose run --rm migrate`。

### 备份与升级

- **备份**：直接备份三个具名 volume（`docker volume inspect` 找到宿主路径后 `tar` 即可）；PostgreSQL 也可用 `pg_dump`。
- **升级 SignalDeck**：`git pull` 后 `docker compose up -d --build`；若 `drizzle` 模式有变更，`migrate` 会在启动时自动补齐。
- **升级 TrendRadar**：仅改 `wantcat/trendradar[:tag]` 与 `wantcat/trendradar-mcp[:tag]` 镜像标签后 `docker compose up -d trendradar trendradar-mcp`，**无需改动 SignalDeck 代码**，其 GPL 源码也不进入本仓库。

## 本地开发

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm lint
pnpm test
pnpm build
docker compose config
```

## 当前进度

- 已建立统一连接器协议和数据模型（`platform_type` 枚举含 `trendradar`）。
- 已实现 X API、WeRSS、Brave Search / Tavily / Serper 全网搜索真实采集链路；凭据可在后台配置，保存后 worker 下一轮生效。
- 已决定通过 Docker/MCP sidecar 复用 TrendRadar，不重复实现其热榜、RSS、关键词规则、AI 报告和通知能力。
- **TrendRadar MCP 适配器已完成并验证**（Task 2）：`src/connectors/trendradar/{mcp-client,trendradar-connector}.ts`，对照 `wantcat/trendradar-mcp@mcp-v4.1.0` 源码核实了 `get_latest_news` / `get_latest_rss` 真实契约（含 `include_url` / `include_summary` 开关、`days` 参数）。
- **统一入库与阅读界面已完成并验证**（Task 4）：
  - `src/db/index.ts`：postgres-js Drizzle 客户端（开发环境单例复用连接）。
  - `src/db/queries.ts`：`getItems`（平台/关键词/时间过滤）、`getMonitorsWithHealth`、`getConnectors`。
  - `src/ingestion/ingest-items.ts`：规范化 + 三级去重（upstreamId → canonicalUrl → contentHash）→ 幂等 upsert 到 `items`，并链接 `item_matches`；`ingest()` 通过可注入的 repository 便于单测。
  - `src/worker/index.ts`：`pnpm worker` 拉取到期监控、按平台分发（trendradar 已全链路打通），记录 `collection_runs` 与健康状态。
  - `src/lib/reader-data.ts`：服务端数据层，未配置 `DATABASE_URL` 或查询失败时回退演示数据，界面不空白。
  - 信息流 `/` 与监控后台 `/admin` 已脱离纯 demo，改为读取真实数据（带演示回退）。
  - 验证：`tsc --noEmit` / `eslint` / `vitest`（15 passed）/ `next build` 均通过；`next start` 冒烟测试首页与后台均返回 200 并渲染演示数据。
- **Docker 交付已补完并验证**（Task 5）：Dockerfile 新增 `tools` 多阶段目标供 `migrate`（一次性 `drizzle-kit migrate`）+ `worker`（常驻 `pnpm worker`）复用；`docker-compose.yml` 补齐 `migrate` / `worker` 服务并让 `web`/`worker` 依赖迁移完成，给 `werss` 加健康检查；`docker compose config` 校验通过；`pnpm worker` 在容器内路径别名解析与 ORM 链路已验证（直连不存在的 DB 仅报连接被拒，证明导入→Drizzle 全链路正常）。README 已补全服务一览、启动顺序、采集原理、健康检查/重启、备份/升级。
- **直连采集器接入与监控 CRUD 已完成并验证（Task 3 · P0 + P1）**：
  - `src/db/connector-seed.ts` + `src/db/seed.ts`：`connectors` 表 4 行基线 seed（固定 UUID，幂等 upsert）；新增 `pnpm db:seed`，`docker-compose` 的 `migrate` 服务改为 `pnpm db:migrate && pnpm db:seed`，解决 `monitors.connectorId` 外键依赖。
  - `src/connectors/factory.ts`：`createXConnector` / `createWebSearchConnector` / `createWeRssConnector` 统一从环境变量构造直连器，worker 与校验接口共用。
  - `src/app/api/monitors/route.ts`：`POST`（zod 校验配置 → 解析 `connectorId` → 落 `monitors`）、`GET`（列表）；`src/app/api/monitors/validate/route.ts`：`POST` 校验配置并返回预览。
  - `src/worker/index.ts`：`gather()` 现返回 `{items, cursor, billableUnits?}`；`x` → `XConnector`、`web_search` → `BraveConnector` 已全链路分发并持久化游标；`wechat` → `WeRssConnector` 已全链路分发（resolve feed → 每轮拉最新页 → 持久化 `mpId` 游标，靠入库去重）。新增 `usageLedger` 记账（X 按 billableUnits、Brave 按查询数；WeChat 成本 0）与 `X_BRAVE_MONTHLY_BUDGET_USD` 月度预算闸门（x/web_search 采集前校验，超额抛 `BUDGET_EXHAUSTED`）。
  - `src/components/monitor-wizard.tsx`：改造为受控表单，接通「验证并预览」→ `/api/monitors/validate`、「保存监控」→ `/api/monitors`（成功后 `router.refresh()`）。
  - 验证：`tsc --noEmit` / `eslint` / `vitest` 全通过（**18 passed**，新增 3 个 worker 分发单测用 mock fetch 覆盖 X 采集+游标推进、Brave 归一化、WeRSS 解析公众号+采集+游标推进）。
- **WeRSS 真实采集已落地（Task 3 · P2）**：
  - 对照 `rachelos/we-mp-rss` 当前接口核实了真实 API：`GET /api/v1/wx/articles?mp_id=&offset=&limit=`（返回 `{code,data:{list,total}}`）、`POST /api/v1/wx/mps/by_article?url=`（由文章 URL 解析公众号）、`POST /api/v1/wx/mps`（订阅公众号），鉴权兼容 `AK-SK key:secret` 与旧版 `Authorization: Bearer <AK>`，`WERSS_ACCESS_KEY` 即该值。
  - `src/connectors/wechat/werss-connector.ts` 重写：`resolveFeed` / `subscribe` / `validate` / `collect` 全部基于真实端点；文章字段（`id`/`mp_id`/`title`/`url`/`description`/`publish_time` 秒级时间戳/`pic_url`/`mp_name`）正确归一化为 `NormalizedItem`。
  - `src/app/api/monitors/route.ts`：保存 wechat 监控时必须先 `subscribe()` 注册公众号；订阅失败会返回 502，不再保存一个“本地成功、WeRSS 后台没有”的假监控；成功后把解析到的 `mpId` 写入 `cursor`，worker 首次运行无需再解析。
  - 至此 X / WeChat / Brave / TrendRadar 四条链路采集层全部打通；剩余仅外部依赖：真实 `X_BEARER_TOKEN` / `BRAVE_SEARCH_API_KEY` / `WERSS_ACCESS_KEY` + 运行中的 Postgres + WeRSS 完成扫码授权。
- **一键启动脚本与快速上手文档（P4 打磨）**：
  - 新增 `start.sh`：首次运行自动复制 `.env.example` → `.env` 并为 `APP_ENCRYPTION_KEY` 生成随机 32-byte 密钥；支持 `start`/`stop`/`restart`/`status`/`logs`/`doctor` 子命令，自动校验 Docker 可用性、compose 配置合法性，并在启动后体检平台凭据是否缺失（仅警告不阻断）。
  - README 新增「快速上手」章节与「平台凭据速查」表，把部署收敛成 `./start.sh` 一条命令；保留原有详细 Docker 章节。
  - 验证：`bash -n` 语法通过；在临时目录实测 macOS/GNU `sed` 两种分支均能正确生成并替换密钥（44 字符 base64）。
