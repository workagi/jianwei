# 更新日志

本项目采用语义化版本思路记录对外发布。发布日期以 GitHub Release 为准。

## [Unreleased]

### Security

- 将间接依赖中的 `postcss` 和 `esbuild` 固定到已修复版本，消除公开前的中等级别安全告警。
- 后台鉴权改为 fail-closed：未配置登录密码时拒绝访问，API Token 不再兼任网页登录密码。

### Added

- Apache-2.0 开源许可和第三方声明。
- 贡献、安全、支持、行为准则和 GitHub 社区模板。
- 可扫描当前文件与 Git 历史的脱敏开源审计。
- GitHub Actions 自动执行审计、lint、测试、构建和 Compose 校验。
- CI 使用真实 PostgreSQL 17 验证数据库迁移和种子数据。
- 采集与模型处理使用可检索的 JSON 结构化日志，并自动遮蔽凭据字段。
- 增加真实内容黄金评估集，分别回归内容类型、主题标签和信息流准入规则。

### Changed

- WeRSS 默认使用公开上游镜像，并允许通过环境变量覆盖。
- 文档改为面向公开用户说明能力、边界和部署方式。
- Worker 使用数据库租约原子领取任务并自动续期，重叠部署不再重复执行同一监控。
- 采集超时会取消连接器的真实网络请求，worker 心跳独立于整轮任务持续刷新。
- 修复跨平台相同 upstream ID 的误判，以及 canonical URL 并发冲突导致整批写入失败的问题。
- 生产 Compose 为 WeRSS、公众号备用采集器和 TrendRadar sidecar 增加资源上限。
- 每个计划采集轮次使用唯一幂等键；同一轮次重试不会重复写入用量账单。
- 将内容、匹配关系、用量、监控游标和采集结果收拢到一个短事务提交，避免半成功状态。
- 模型 RPM 改为 PostgreSQL 共享节流，多 Worker 不再各自独立放大请求速率。
- X、SuperGrok 和付费搜索在请求前原子预留预算，成功结算、失败释放，并自动回收过期预留；额度耗尽后等待下一预算周期，不再反复重试或误停用监控。
- 内容实体、来源观察和监控命中拆分为三层数据模型；同一文章可保留多个平台来源，平台筛选不再受首次入库来源限制。
- 内容类型规则加入强证据权重，避免带 LLM 的论文被误判为模型发布、多模态模型发布被误判为普通产品动态。
- 信息流按北京时间真实分日，跨零点内容会显示新的日期标题，不再混入上一组。
- 采集失败统一分类为授权、限流、额度、超时、配置、网络和上游异常；后台显示可操作说明，技术原文仅留在日志中。
- 相关性迁移完成：retentionReason、relevanceScore、retentionSource 只写入 item_matches；
  items 表保留 informationValueScore 作为文档级质量分；读者 COALESCE 默认走 match 层。
- 第三方镜像固定版本（trendradar:6.10.0 / trendradar-mcp:4.1.0 / wechat-download-api:1.7.0）。
- 会话 Cookie 升级为带时间戳的签名载荷（iat/exp/sid），向后兼容旧格式。
- 登录限流从进程内存迁移到 PostgreSQL（login_attempts 表），重启和多副本安全共享。

- 登录限流修复窗口过期后无法重置的 bug（setWhere → CASE 原子 upsert）。
- 会话 Cookie 验证比对数据库 sessionVersion；改密码自动递增，旧 Cookie 即时失效。
- 旧 HMAC Cookie 设置 2026-09-01 兼容截止时间。
- claimMonitor 检查 RETURNING 行数，claim 丢失记录 warning 日志。
- due monitor 查询加 ORDER BY nextRunAt + LIMIT 20，lease 续约检查 affected rows。
## [0.1.0]

- 完成单用户自托管信息流闭环。
- 支持 X / Twitter、微信公众号、全网搜索、榜单和 RSS。
- 支持规则过滤、去重、模型摘要、中文化、分类、标签与推荐理由。
- 提供 Docker Compose、本地启动脚本和生产部署方案。
