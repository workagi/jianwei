# 见微开源准备报告

> 检查日期：2026-07-22
> 目标：让仓库具备安全公开条件，但在所有者最终确认前保持 Private  
> 许可证：Apache License 2.0

这份报告记录可重复验证的技术检查，不构成法律意见。平台条款和许可证发生变化时需要重新核对。

## 1. 当前结论

| 检查项 | 状态 | 结论 |
| --- | --- | --- |
| 主程序许可证 | 通过 | 已添加 Apache-2.0 与 `NOTICE` |
| 第三方边界 | 通过 | MIT 改编代码已保留声明；GPL/AGPL 项目保持独立容器 |
| 当前文件凭据扫描 | 通过 | 未发现常见真实凭据格式 |
| Git 历史凭据扫描 | 通过 | 当前全部提交的文本补丁未发现常见真实凭据格式 |
| Git 提交邮箱隐私 | 通过 | 公开历史统一使用 GitHub `noreply` 邮箱，不暴露个人 Gmail 地址 |
| 本地文件追踪 | 通过 | `.env`、数据库、私钥、构建目录和本地数据未被追踪 |
| Node.js 依赖许可证 | 通过 | 433 个已安装包未发现未知许可证 |
| 公开安装镜像 | 已修复 | 默认 WeRSS 从本机镜像改为上游公开镜像 |
| 社区治理 | 通过 | 已添加贡献、安全、支持、行为准则和 Issue/PR 模板 |
| 自动化门禁 | 已添加 | CI 执行开源审计、lint、test、build 与 Compose 校验 |
| 依赖自动更新 | 已添加 | 同生态小版本合并更新，跨大版本保留人工评估 |
| 依赖漏洞提醒 | 已启用 | GitHub vulnerability alerts 已在私有阶段开启 |
| 全新机器安装 | 待人工确认 | 发布前仍需在干净环境运行一次 `./start.sh` |
| GitHub 仓库归属 | 通过 | 已迁移至 `workagi/jianwei`，提交、标签与协作记录保留 |
| GitHub 可见性 | 待最终切换 | 发布门禁通过后由仓库所有者批准切换为 Public；随后启用私有漏洞报告 |

## 2. 敏感信息审计

公开前使用：

```bash
pnpm audit:open-source -- --history
```

脚本会检查：

- 被 Git 追踪或准备提交的 `.env`、私钥、数据库、构建目录和系统文件。
- GitHub、OpenAI-compatible、xAI、Hugging Face、AWS、Google、Slack 和 Stripe 等常见凭据格式。
- 可选的全部 Git 历史文本补丁。

审计输出只显示规则和位置，不打印匹配到的值。任何命中都必须先删除历史并轮换凭据，不能只在最新提交中删除。

脚本不是专业秘密扫描器的完全替代。仓库公开后建议同时启用 GitHub Secret Scanning 与 Push Protection。

## 3. 依赖与许可证

### 主程序

- 见微原创代码与文档：Apache-2.0。
- Hermes Agent 改编的 xAI OAuth 流程：MIT，声明已保留在 `THIRD_PARTY_NOTICES.md`。

### 独立服务

| 项目 | 许可证 | 集成方式 | 边界 |
| --- | --- | --- | --- |
| WeRSS / we-mp-rss | MIT | 独立 Docker 服务 | 通过 HTTP/API 通信 |
| TrendRadar | GPL-3.0 | 独立 Docker/MCP Sidecar | 不复制源码，不链接进主程序 |
| wechat-download-api | AGPL-3.0 | 可选 Docker profile | 不复制源码，只调用兼容 HTTP 接口 |

`pnpm-lock.yaml` 固定 Node.js 依赖版本。当前安装树共检查 433 个包，许可证包括 MIT、Apache-2.0、BSD、ISC、MPL-2.0、LGPL-3.0-or-later、CC、Python-2.0 和 Unlicense，未发现 `UNKNOWN` 或 `UNLICENSED`。

## 4. 已处理的公开安装阻塞

原 Compose 引用 `we-mp-rss:with-chromium`，这是只存在于开发者机器上的本地镜像。公开用户无法拉取，会导致第一次启动失败。

现在默认在本地构建 `jianwei-werss:local`，基础镜像使用：

```text
ghcr.io/rachelos/we-mp-rss:latest
```

高级用户可以通过 `WERSS_IMAGE` 使用自行审核和构建的镜像。构建文件和补丁均包含在仓库中，不再依赖开发者机器上预先存在的私有镜像；需要 Chromium 的全文能力由可选增强通道承担。

代码中仍保留少量 `signaldeck` 内部字符串，用于兼容既有数据库键、加密开发默认值和进程锁。这些是历史稳定标识，不代表对外产品名称；为避免升级后重复入库或无法解密，本次不做破坏性改名。

## 5. 自动化发布门禁

GitHub Actions 在 `main` push 和 Pull Request 时运行：

```bash
pnpm install --frozen-lockfile
pnpm audit:open-source -- --history
pnpm lint
pnpm test
pnpm build
docker compose config
```

真实平台凭据不是测试和构建的前置条件。CI 中仅使用不可用于生产的占位配置。

## 6. 发布前仍需人工完成

- [ ] 在一个全新目录或另一台没有本项目镜像和 volumes 的机器运行 `./start.sh`。
- [x] README 当前未嵌入信息流截图或真实演示数据，不含真实账号内容。
- [ ] 仓库切换为 Public 后立即启用 Private vulnerability reporting。
- [x] `NOTICE` 使用 `skymao2021` 作为当前权利人标识。
- [x] 公众号与 X 功能说明明确标注第三方边界、账号风险与非永久稳定性。
- [ ] 创建公开 Release，并说明实验性采集路径和已知限制。
- [x] 仓库所有者已明确批准将仓库可见性切换为 Public。

## 7. 公开当天

1. 再次运行所有 CI 检查与历史审计。
2. 确认默认分支为 `main`，分支保护要求 CI 通过。
3. 将仓库可见性切换为 Public。
4. 立即启用 Private vulnerability reporting，并检查安全通知接收设置。
5. 创建首个公开 Release，不直接复用未经说明的私有标签。
6. 发布公众号文章时以用户价值和真实限制为主，不把非官方采集包装成平台承诺。
