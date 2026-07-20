# 参与贡献

感谢你愿意帮助见微变得更好。这个项目首先服务于单用户、自托管的信息监控场景，因此稳定、可解释和安全优先于快速堆功能。

## 开始之前

- 普通问题和建议请先搜索已有 Issue。
- 安全漏洞不要公开提交，请阅读 [SECURITY.md](SECURITY.md)。
- 第三方平台登录、额度或风控变化不一定是见微缺陷，请先阅读 [SUPPORT.md](SUPPORT.md)。
- 不要提交真实 API Key、Cookie、二维码、公众号后台数据、个人信息或生产日志。

## 本地开发

需要 Node.js 22、pnpm 10.28.1，以及用于完整联调的 Docker。

```bash
git clone https://github.com/skymao2021/jianwei.git
cd jianwei
pnpm install --frozen-lockfile
cp .env.example .env
pnpm test
pnpm dev
```

只运行单元测试不需要真实平台凭据。完整 Docker 环境可以执行：

```bash
./start.sh
```

## 提交一个修改

1. 从 `main` 创建描述清楚的分支。
2. 一次 Pull Request 只解决一个明确问题。
3. 修复缺陷时先补充能够复现问题的测试。
4. 不要改变采集频率、认证边界或第三方调用策略而不说明风险。
5. 更新与行为相关的 README、项目手册或升级说明。
6. 提交前运行完整检查。

```bash
pnpm audit:open-source
pnpm lint
pnpm test
pnpm build
docker compose config
git diff --check
```

## 提交信息

建议使用简短、可搜索的格式：

```text
feat: add a source provider
fix: prevent duplicate WeChat ingestion
docs: clarify production deployment
test: cover staggered retry scheduling
chore: update dependency metadata
```

## 需要特别审查的区域

以下修改会获得更严格的审查：

- 登录、会话、凭据加密和管理 API。
- X、微信和搜索 Provider 的认证或采集行为。
- Docker 端口、网络、volume 和生产部署。
- 数据库迁移、删除任务和历史数据回填。
- 提高采集并发、缩短频率或绕过第三方限制。
- 新增 GPL、AGPL、非商业或来源不明的代码与镜像。

## 贡献许可

提交贡献即表示你有权提供这些内容，并同意按照项目的 [Apache License 2.0](LICENSE) 授权该贡献。不要提交无法确认来源或许可证的代码、图片、文案和数据。

所有参与者都需要遵守 [行为准则](CODE_OF_CONDUCT.md)。
