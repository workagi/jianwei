# 第三方声明

见微主程序使用 [Apache License 2.0](LICENSE) 发布。本文件记录主程序中改编的代码，以及默认 Docker 方案所连接的独立开源服务。

第三方项目的商标、服务和内容不属于见微。各项目仍适用自己的许可证、使用条款和隐私规则。

## Hermes Agent

- 项目：<https://github.com/NousResearch/hermes-agent>
- 许可证：MIT
- 版权所有：Copyright (c) 2025 Nous Research
- 使用方式：`src/lib/xai-oauth.ts` 的 xAI device-code OAuth 流程参考并改编自 Hermes Agent。

以下 MIT 许可声明适用于上述改编部分：

```text
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

SuperGrok 权益、xAI OAuth/API 行为和 X Search 结果仍由 xAI 控制，可能随时调整。见微不隶属于 X 或 xAI。

## WeRSS / we-mp-rss

- 项目：<https://github.com/rachelos/we-mp-rss>
- 许可证：MIT
- 版权所有：Copyright (c) 2025 RACHEL
- 使用方式：作为独立 Docker 服务运行，通过 HTTP/API 与见微通信；源码没有复制到见微主程序。

默认 Compose 使用上游公开镜像。用户可以通过 `WERSS_IMAGE` 覆盖镜像，但需要自行核对替代镜像的来源和许可证。

## TrendRadar

- 项目：<https://github.com/SANSAN0/TrendRadar>
- 许可证：GPL-3.0
- 使用方式：作为独立 Docker/MCP Sidecar 运行；见微只读写配置和消费结构化输出，未复制 TrendRadar 源码。

TrendRadar 的 GPL-3.0 义务继续适用于 TrendRadar 自身及其修改版本。见微与 TrendRadar 保持进程和发布边界，详见 [集成架构说明](docs/architecture-trendradar.md)。

## wechat-download-api

- 项目：<https://github.com/tmwgsicp/wechat-download-api>
- 许可证：AGPL-3.0
- 使用方式：可选的独立 Docker 服务，仅在用户主动启用 `wechat-fallback` profile 时运行；见微通过兼容 HTTP 接口调用，未复制其源码。

如果修改该服务并通过网络向用户提供功能，需要自行履行 AGPL-3.0 的源代码提供义务。不开启该 profile 不影响见微的基本运行。

## JavaScript 与 Node.js 依赖

依赖版本固定在 `pnpm-lock.yaml`。发布前会在 CI 中执行依赖安装和许可证检查。当前安装树中未发现未知许可证；出现的 MIT、Apache-2.0、BSD、ISC、MPL-2.0、LGPL、CC 和 Python-2.0 等许可证仍分别适用于对应依赖。

如发现遗漏或归属错误，请提交 Issue；涉及法律或安全敏感信息时，请按 [SECURITY.md](SECURITY.md) 私下报告。
