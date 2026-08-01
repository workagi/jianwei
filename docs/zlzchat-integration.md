# ZLZChat 备选通道

见微支持把**用户自行部署的 ZLZChat**作为微信公众号的可选订阅通道。它不是 WeRSS 的自动故障转移，也不会随见微的 Docker Compose 一起安装。

## 为什么保持外置

- ZLZChat 上游仓库当前没有明确的开源许可证，见微不复制或再分发其程序。
- 其采集链依赖微信读书账号和第三方接口，可能受账号状态、风控和上游变化影响。
- 外置部署可以把故障、账号和资源消耗与见微及 WeRSS 隔离。
- 生产环境必须使用自己控制并完成安全审计的实例；不要把凭据交给公开演示站。见微会拒绝已知的上游公开演示地址。

特别注意：审计过的 ZLZChat 上游版本中，微信读书凭据刷新逻辑默认会请求作者控制的 `API_SERVER`。把容器放到自己的服务器上，并不自动代表账号数据不会离开服务器。正式使用前必须检查实际镜像/JAR，移除或替换这条中转链路；无法确认时，不要在里面登录重要账号。

## 配置

1. 按 ZLZChat 上游说明在独立主机、容器或私有网络中部署，并在其后台启用文章定时同步。
2. 在见微「平台连接」填写 `ZLZCHAT_BASE_URL` 和 `ZLZCHAT_API_KEY`。地址应是见微 `web`、`worker` 容器都能访问的私有地址。
3. 新建「微信公众号」监控，把采集通道改为 `ZLZChat · 外置备选`。
4. 粘贴公众号文章链接并先点「预览公众号」。预览会在 ZLZChat 中创建订阅；首次订阅可以自动识别，如果该公众号已经存在于 ZLZChat，需从其后台复制 `wxsId`，避免见微猜错绑定。
5. 确认预览中的公众号名称和文章正确后再保存。

也可以使用环境变量：

```env
ZLZCHAT_BASE_URL=http://zlzchat:805
ZLZCHAT_API_KEY=replace-with-your-key
ZLZCHAT_TIMEOUT_SECONDS=15
ZLZCHAT_PAGE_SIZE=30
```

不要在 URL 中携带用户名、密码或 API Key。API Key 会单独保存并加密；请求错误和见微日志不会输出带 Key 的完整请求地址。ZLZChat 的接口契约要求把 Key 放在查询参数中，因此其反向代理和访问日志也应关闭查询串记录或对 `key` 做脱敏。

## 稳定性策略

- 默认关闭：未配置时不会调用 ZLZChat。
- 每次请求有超时，并只对临时网络错误做一次短重试。
- 连续失败会打开进程内熔断器，避免故障服务持续拖住 worker。
- ZLZChat 与 WeRSS 使用不同 provider 身份、游标和并发桶；一个通道失败不会改写另一个通道的状态。
- 相同文章仍通过来源身份和 canonical URL 进入见微统一去重链路。

这些措施保证的是**故障隔离和可恢复性**，不是对第三方采集成功率的承诺。微信没有面向任意公众号订阅的官方开放 API；账号风控、登录状态和上游接口变化仍需部署者自行处理。

## 排错

| 现象 | 处理 |
| --- | --- |
| `ZLZCHAT_BASE_URL_MISSING` / `ZLZCHAT_API_KEY_MISSING` | 到「平台连接」补齐地址和 Key |
| `ZLZCHAT_AUTH_REQUIRED` | 核对 Key 是否与自建实例一致 |
| `ZLZCHAT_WXS_ID_REQUIRED` | 到 ZLZChat 后台复制该公众号的 `wxsId` |
| `ZLZCHAT_RATE_LIMITED` | 降低采集频率，等待上游风险窗口结束 |
| `ZLZCHAT_CIRCUIT_OPEN` | 上游连续失败，等待熔断窗口结束并检查 ZLZChat 日志 |
| 已绑定但没有文章 | 确认 ZLZChat 的定时同步任务已启用且微信读书账号可用 |
