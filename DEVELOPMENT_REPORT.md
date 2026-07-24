# 见微（Jianwei）项目开发全景报告

**仓库**: [workagi/jianwei](https://github.com/workagi/jianwei)  
**当前版本**: v0.1.0  
**报告日期**: 2026-07-25  
**总提交数**: 84 commits  
**报告范围**: 从初始代码审查到 CI 全线绿灯

---

## 一、项目概述

见微是一个自托管的信息监控系统，支持微信公众号、X/Twitter、网页搜索、TrendRadar 等多平台内容采集，通过规则引擎 + AI 模型进行内容筛选和相关性评分，最终呈现在统一的信息流中。

**技术栈**: Next.js 22 + PostgreSQL 17 + Drizzle ORM + Docker Compose + Caddy

**定位**: 单用户自托管，注重隐私和成本控制。

---

## 二、开发阶段划分

### 阶段 0：项目初始化（commit 1-5）

从 Create Next App 脚手架起步，建立基础的 Next.js + PostgreSQL + Drizzle 架构，发布私有初始版本 v0.1.0。

**关键里程碑**: v0.1.0 发布、项目文档整理、开源准备。

---

### 阶段 1：五轮代码审查（ChatGPT 侧）

项目经历了 **5 轮**由 AI 驱动的深度代码审查，每轮审查聚焦不同维度的风险：

| 轮次 | 重点 | 发现的核心问题 |
|------|------|---------------|
| 第 1 轮 | 全面技术尽调 | 鉴权 fail-open、worker 无原子抢占、timeout 只停等待不取消请求、采集半成功状态、跨平台 upstreamId 误判、canonical URL 竞态、数据模型三层概念混在一张表 |
| 第 2 轮 | 整改验证 + 深挖 | lease 缺少 fencing token、登录限流窗口重置 bug、会话版本未生效、规则未做 monitor 级判断、来源 observation 被覆盖 |
| 第 3 轮 | 回归检测 | 旧 worker 提交绕过 fencing、source_items 静默换绑文档、observation 幂等未生效、重复模型分析、worker 串行队头阻塞、monitor 永久禁用策略过重 |
| 第 4 轮 | CI + 部署 | 生产 worker 不启动、source_items UPSERT SQL 崩溃、健康检查读写不一致、排除词硬过滤未生效、CI 缺真实 PostgreSQL |
| 第 5 轮 | 整合审查 | worker ID 两套随机值、规则硬排除被读者查询忽略、并发轮次穿透、旧来源 key 格式不一致、租约丢失混同 shutdown |

---

### 阶段 2：架构整改（commit 6-35）

根据审查结果，进行了三轮大规模架构重构：

**A. 数据模型三层拆分**
- `items` → 纯 canonical 文档实体
- `source_items` → 来源观察记录（平台 + provider + upstreamId）
- `item_matches` → 监控与文档的匹配关系
- `monitor_match_observations` → 每次发现的独立证据
- `document_analysis_claims` → 防止并发重复模型分析

**B. 分布式协调**
- Monitor lease fencing（owner + epoch）
- Collection run attempt token
- 共享模型限流（PostgreSQL 令牌桶）
- 预算原子预留

**C. 规则系统**
- Gate/Rank/Explain 三层语义
- DocumentAnalysis 与 MonitorMatchAnalysis 拆分
- 黄金规则评估集

**D. CI 基础设施**
- 接入真实 PostgreSQL 17
- Docker 完整启动烟雾测试
- 数据库升级测试
- Playwright E2E 测试

---

### 阶段 3：CI 全线修复（Codex 侧，commit 36-42）

此阶段解决的问题是 CI 流水线中逐个暴露的 8 个阻断性缺陷：

| # | 问题 | 修复提交 | 症状 |
|---|------|---------|------|
| 1 | `docker-compose.prod.yml` wechat-fallback 缩进错误 | `6f27918` | `docker compose config` 报 YAML parse error |
| 2 | chaos test `returning()` 与 Drizzle `sql` 模板组合返回值类型不一致 | `6f27918` | 测试时返回对象而非数组，`toHaveLength()` 报错 |
| 3 | DB upgrade test 手动 psql + drizzle-kit 双重执行导致冲突 | `c5946dd` | CREATE TABLE 重复执行报错 |
| 4 | CI smoke/e2e job 缺 `POSTGRES_PASSWORD` | `74fd8fd` | `docker compose up` 报缺少强制变量 |
| 5 | DB upgrade 校验表名列表含不存在的 `workers`/`admin_settings` | `e0a7a7b` | 升级测试验证步骤失败 |
| 6 | CI 缺 `JIANWEI_DOMAIN`/`APP_ENCRYPTION_KEY`/`TRENDRADAR_REFRESH_TOKEN` | `d91bcc7` | 同上 |
| 7 | E2E test `text=` locator 匹配了 sidebar + 登录介绍文字共 3 个元素 | `b4db078` | Playwright strict mode 报 `resolved to 3 elements` |
| 8 | 生产 compose 只暴露 Caddy 80/443，CI `curl localhost:3000` 连不上 | `5cd44fc` | 新增 `docker-compose.ci.yml` 暴露 web 端口 |

**结果**: CI 四道关卡（validate → smoke → db-upgrade → e2e）全线绿灯。

---

### 阶段 4：部署与脚本打磨（commit 43-44）

| # | 问题 | 修复提交 |
|---|------|---------|
| 9 | `start.sh` 第 165 行 `local s` 在函数外使用，bash 语法错误阻断首次部署 | `618eec0` |
| 10 | CI 新增 ShellCheck 步骤，自动检查 shell 脚本语法 | `618eec0` |
| 11 | `uninstall.sh` 4 处 ShellCheck 警告（`read` 缺 `-r`、未使用变量） | `ff4e8d3` |

---

### 阶段 5：文档与用户体验（并行进行）

| 修改 | 内容 |
|------|------|
| README 重写 | 默认凭据说明、安全提醒、远程部署指南、WeRSS AK 配置指引 |
| 新手上路指南 | 5 分钟入门，从技术配置改为纯小白教程 |
| 流程顺序修正 | 先配信息源（公众号/X API 等），再添加监控 |
| start.sh 增强 | 部署完成输出远程访问提示、配置指引 |
| uninstall.sh | 一键卸载脚本（交互式/自动模式），清理容器/卷/镜像/目录 |
| 默认密码统一 | `admin@123`，与 WeRSS 保持一致 |

---

## 三、当前项目架构

```
┌─────────────────────────────────────┐
│            Caddy (80/443)           │  ← 唯一公网入口
└─────────────┬───────────────────────┘
              │
    ┌─────────┼──────────┬──────────────┐
    │         │          │              │
  web      worker    Postgres    WeRSS/TrendRadar
(Next.js) (采集引擎)  (数据)      (第三方采集)
    │         │
    └────┬────┘
         │
    ┌────┴────┐
    │ 规则引擎 │ → Gate(硬过滤) → Rank(打分) → Explain(解释)
    └────┬────┘
         │
    ┌────┴────┐
    │ 模型分析 │ → DocumentAnalysis(一次) + MonitorMatchAnalysis(每个监控)
    └────┬────┘
         │
    ┌────┴────────────┐
    │    数据持久化     │
    │ items            │ ← canonical 文档
    │ source_items     │ ← 来源观察
    │ item_matches     │ ← 监控匹配
    │ observations     │ ← 发现证据
    │ collection_runs  │ ← 运行记录
    └─────────────────┘
```

### 核心设计原则

1. **调度与执行分离** — Scheduler 创建任务，worker 消费任务
2. **内容与来源分离** — Document 表示"它是什么"，SourceItem 表示"从哪里来"
3. **文档分析与监控相关性分离** — 摘要属于 document，相关性属于 monitor match
4. **外部调用与数据库提交分离** — 外部阶段可重试，提交阶段短事务、强幂等
5. **每次运行都有业务幂等键** — `monitorId + scheduledFor + taskVersion`

---

## 四、CI/CD 流水线

当前 CI 包含 4 个 job，全部 required：

```
validate (Audit, test and build)
  ├─ pnpm install
  ├─ db:migrate + db:seed
  ├─ 开源发布安全审计
  ├─ 内容规则评估 (continue-on-error, < 70% 才失败)
  ├─ ShellCheck (start.sh, uninstall.sh, test-upgrade.sh)
  ├─ ESLint
  ├─ Vitest (含 DB 集成测试)
  ├─ Next.js build
  └─ docker compose config 验证
      │
      ├── smoke (Docker 烟雾测试)
      │     ├─ docker compose up --build --wait
      │     ├─ 健康检查
      │     └─ 登录页验证
      │
      ├── db-upgrade (数据库升级测试)
      │     └─ 全量 migration 执行 + schema 校验
      │
      └── e2e (Playwright E2E)
            ├─ 登录流程
            ├─ Reader 信息流
            ├─ 平台过滤
            └─ Connectors 页面
```

---

## 五、部署清单

### 最低配置

- CPU: 2 核
- 内存: 4GB（WeRSS/Playwright 需预留资源）
- 磁盘: 20GB（PostgreSQL 数据 + Docker 镜像）
- 系统: Ubuntu 20.04+ / Debian 11+，需 Docker 29+

### 快速部署

```bash
git clone https://github.com/workagi/jianwei.git
cd jianwei
./start.sh
```

`start.sh` 自动完成：生成随机密钥 → 写入 `.env` → 构建镜像 → 启动服务 → 输出访问地址。

### 首次登录

- 地址: `http://你的服务器IP:3000/admin`
- 账号: `admin`
- 密码: `admin@123`
- **强烈建议首次登录后立即修改密码**

### 新手配置顺序

1. 登录后台 → 进入「平台连接」
2. 配置公众号：打开 WeRSS 后台 → 扫码授权 → 创建 Access Key → 填入 `.env` 的 `WERSS_ACCESS_KEY`
3. 配置 X/Twitter：填入 `X_BEARER_TOKEN` 或 SuperGrok
4. 配置搜索服务商：Brave API Key / Tavily / Serper
5. 配置模型 API（可选）
6. 进入「监控任务」→ 创建监控（选择平台、设置关键词/必含词/排除词）
7. 回到首页查看信息流

### 卸载

```bash
./uninstall.sh           # 交互式逐步确认
./uninstall.sh --yes     # 一键全部删除
```

---

## 六、后续开发建议

### 当前已知的架构债务（P1/P2，不影响单机部署）

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P1 | provider 级并发隔离 | 微信/X/搜索目前共享全局并发，慢任务可能互相阻塞 |
| P1 | 规则评估集扩大 | 当前 ~100 条，建议逐步到 500+ 并加 confusion matrix |
| P1 | item_matches 增加 retention_status | 区分 kept/gate_blocked/pending，Reader 只查 kept |
| P1 | worker 大文件拆分 | `src/worker/index.ts` 已 ~1150 行，建议按职责拆 module |
| P2 | 加密密钥版本轮换 | 目前仅支持单密钥，需增加 keyId + 多密钥解密 |
| P2 | worker 生产运行时 | 当前用 tsx 跑 TypeScript，建议编译为 JS |
| P2 | 备份恢复演练 | 目前有备份脚本但缺少自动化恢复测试 |

### 不建议现在做的

- 换 UI 框架或重构前端
- 增加更多数据源（先把现有稳定性做扎实）
- 换数据库或 ORM
- 支持多用户/多租户

---

## 七、给接手开发的同事

### 本地开发

```bash
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev          # Next.js 开发服务器
pnpm worker:dev   # worker 开发模式
pnpm test         # 单元测试 + 集成测试（需 RUN_DB_INTEGRATION_TESTS=1）
pnpm test:e2e     # Playwright E2E
pnpm lint         # ESLint
```

### 提交前检查

- `pnpm lint` 必须通过
- `pnpm test` 必须通过（有 PostgreSQL 时）
- CI 全绿后再合入 main
- main 分支已设保护，禁止直接 push，必须 PR

### CI 如果红了

按这个顺序排查：
1. 看 ShellCheck / Lint / Test 哪个先挂
2. ShellCheck 报错 → 修正 shell 脚本语法
3. Test 报错 → 优先看 integration test（chaos、distributed-coordination、data-invariants）
4. DB upgrade 报错 → 检查 migration snapshot 是否和 schema.ts 一致
5. E2E 报错 → 检查 locator 是否过于宽泛导致 strict mode 冲突

### 关键文件速查

| 文件 | 作用 |
|------|------|
| `src/worker/index.ts` | worker 主循环、调度、执行 |
| `src/db/schema.ts` | Drizzle 数据库 schema |
| `src/ingestion/` | 入库管线（prepare + commit） |
| `src/lib/auth.ts` | 鉴权逻辑 |
| `src/sources/` | provider connector 实现 |
| `drizzle/` | migration SQL 文件 |
| `.github/workflows/ci.yml` | CI 配置 |
| `docker-compose.prod.yml` | 生产部署 compose |
| `docker-compose.ci.yml` | CI 专用端口暴露 |
| `start.sh` | 一键部署脚本 |
| `uninstall.sh` | 一键卸载脚本 |

---

## 八、效率总结

| 指标 | 数据 |
|------|------|
| 总提交数 | 84 |
| 代码审查轮次 | 5 轮 |
| 修复的 P0/P1 问题 | 30+ |
| CI 修复次数 | 11 次 |
| 当前 CI 状态 | ✅ 全绿 |
| 文档新增/修改 | README、新手指南、部署报告 |
| shell 脚本 | start.sh、uninstall.sh、test-upgrade.sh |

---

*报告由 Codex 基于 `/Users/moweijia/codex/jianwei` 仓库的 git 历史自动生成。*
