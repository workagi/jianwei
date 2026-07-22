import type { PlatformType } from "@/connectors/types";

export type MonitorErrorCode =
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "COLLECTION_TIMEOUT"
  | "CONFIGURATION_ERROR"
  | "SOURCE_STALE"
  | "NETWORK_ERROR"
  | "UPSTREAM_UNAVAILABLE"
  | "SOURCE_NOT_FOUND"
  | "INVALID_RESPONSE"
  | "RUN_INTERRUPTED"
  | "COLLECTION_FAILED";

export interface MonitorFailure {
  code: MonitorErrorCode;
  retryable: boolean;
  retryAfterMinutes?: number;
  disableEligible: boolean;
}

/** Convert provider-specific error strings into a stable operational contract. */
export function classifyMonitorFailure(message: string): MonitorFailure {
  const value = message.trim();
  const upper = value.toUpperCase();
  if (/RUN_INTERRUPTED|WORKER_SHUTDOWN|TEST_CANCELLED/.test(upper)) {
    return { code: "RUN_INTERRUPTED", retryable: true, retryAfterMinutes: 10, disableEligible: false };
  }
  if (/BUDGET_EXHAUSTED|QUOTA_EXHAUSTED|INSUFFICIENT_(?:BALANCE|CREDIT)/.test(upper)) {
    return { code: "QUOTA_EXHAUSTED", retryable: false, disableEligible: false };
  }
  if (/WERSS_FEED_(?:STALE|NEVER_SYNCED)/.test(upper)) {
    return { code: "SOURCE_STALE", retryable: true, disableEligible: false };
  }
  if (/SUPERGROK_AUTH|NOT_ENTITLED|(?:^|[_: ])(?:401|403)(?:$|[_: ])|AUTH_REQUIRED|UNAUTHORIZED|FORBIDDEN|TOKEN_(?:EXPIRED|INVALID)/.test(upper)) {
    return { code: "AUTH_REQUIRED", retryable: false, disableEligible: true };
  }
  if (/(?:^|[_: ])429(?:$|[_: ])|RATE_LIMIT/.test(upper)) {
    return { code: "RATE_LIMITED", retryable: true, retryAfterMinutes: 10, disableEligible: false };
  }
  if (/TIMEOUT|TIMED_OUT|ABORTERROR/.test(upper)) {
    return { code: "COLLECTION_TIMEOUT", retryable: true, retryAfterMinutes: 10, disableEligible: false };
  }
  if (/API_KEY.*(?:未配置|REQUIRED|MISSING)|CONFIG(?:URATION)?_(?:REQUIRED|INVALID)|UNKNOWN_SOURCE_PROVIDER|APP_ENCRYPTION_KEY/.test(upper)) {
    return { code: "CONFIGURATION_ERROR", retryable: false, disableEligible: true };
  }
  if (/FETCH FAILED|NETWORK|UND_ERR|ECONN|ENOTFOUND|EAI_AGAIN|SOCKET|DNS/.test(upper)) {
    return { code: "NETWORK_ERROR", retryable: true, retryAfterMinutes: 10, disableEligible: false };
  }
  if (/(?:^|[_: ])5\d\d(?:$|[_: ])|UNAVAILABLE|CIRCUIT_OPEN|NO_RESPONSE|MCP_(?:INIT|TOOL)_FAILED/.test(upper)) {
    return { code: "UPSTREAM_UNAVAILABLE", retryable: true, retryAfterMinutes: 10, disableEligible: false };
  }
  if (/USER_NOT_FOUND|FEED_NOT_RESOLVED|SOURCE_NOT_FOUND|\b404\b/.test(upper)) {
    return { code: "SOURCE_NOT_FOUND", retryable: false, disableEligible: true };
  }
  if (/INVALID|PARSE|NO_TEXT_CONTENT|EMPTY_RESPONSE|返回为空/.test(upper)) {
    return { code: "INVALID_RESPONSE", retryable: false, disableEligible: true };
  }
  return { code: "COLLECTION_FAILED", retryable: false, disableEligible: true };
}

export function presentMonitorFailure(input: {
  code?: string | null;
  message?: string | null;
  platform?: PlatformType;
}): { health: string; detail: string } {
  const classified = input.code && isMonitorErrorCode(input.code)
    ? { code: input.code }
    : classifyMonitorFailure(input.message ?? "");
  const platform = input.platform;
  switch (classified.code) {
    case "AUTH_REQUIRED":
      return {
        health: "需要授权",
        detail: platform === "wechat"
          ? "微信公众号授权已失效，请到“平台连接”重新扫码"
          : platform === "x"
            ? "请到“平台连接”重新授权 SuperGrok，或检查 X API 密钥"
            : "请到“平台连接”检查该服务的 API 密钥",
      };
    case "RATE_LIMITED":
      return { health: "接口限流", detail: "外部服务触发频率限制，系统已错峰并将在约 10 分钟后重试" };
    case "QUOTA_EXHAUSTED":
      return { health: "额度用尽", detail: "已暂停调用，补充额度或进入下一个额度周期后会继续采集" };
    case "COLLECTION_TIMEOUT":
      return { health: "采集超时", detail: "外部服务响应过慢，本次请求已取消并将在约 10 分钟后重试" };
    case "CONFIGURATION_ERROR":
      return { health: "配置有误", detail: "当前来源缺少必要配置，请到“平台连接”检查地址和密钥" };
    case "SOURCE_STALE":
      return { health: "公众号源停更", detail: "WeRSS 长时间没有同步该公众号；任务已保留并等待上游恢复" };
    case "NETWORK_ERROR":
      return { health: "网络异常", detail: "当前无法连接外部服务，系统已错峰并将在约 10 分钟后重试" };
    case "UPSTREAM_UNAVAILABLE":
      return { health: "上游异常", detail: "外部采集服务暂不可用，系统已错峰并将在约 10 分钟后重试" };
    case "SOURCE_NOT_FOUND":
      return { health: "来源不存在", detail: "没有找到对应账号或订阅源，请检查名称、链接或账号状态" };
    case "INVALID_RESPONSE":
      return { health: "返回异常", detail: "外部服务返回了无法识别的数据，请检查服务版本或稍后重试" };
    case "RUN_INTERRUPTED":
      return { health: "采集中断", detail: "worker 在任务完成前重启，系统会自动重新安排采集" };
    default:
      return { health: "采集失败", detail: "本次采集未完成；系统已记录技术详情，可在运行日志中排查" };
  }
}

function isMonitorErrorCode(value: string): value is MonitorErrorCode {
  return [
    "AUTH_REQUIRED",
    "RATE_LIMITED",
    "QUOTA_EXHAUSTED",
    "COLLECTION_TIMEOUT",
    "CONFIGURATION_ERROR",
    "SOURCE_STALE",
    "NETWORK_ERROR",
    "UPSTREAM_UNAVAILABLE",
    "SOURCE_NOT_FOUND",
    "INVALID_RESPONSE",
    "RUN_INTERRUPTED",
    "COLLECTION_FAILED",
  ].includes(value);
}
