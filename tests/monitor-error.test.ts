import { describe, expect, it } from "vitest";
import {
  classifyMonitorFailure,
  monitorFailureAccounting,
  presentMonitorFailure,
} from "@/lib/monitor-error";

describe("classifyMonitorFailure", () => {
  it.each([
    ["SUPERGROK_AUTH_EXPIRED", "AUTH_REQUIRED"],
    ["BRAVE_429", "RATE_LIMITED"],
    ["GATHER_TIMEOUT:wechat", "COLLECTION_TIMEOUT"],
    ["fetch failed", "NETWORK_ERROR"],
    ["XAI_X_SEARCH_503", "UPSTREAM_UNAVAILABLE"],
    ["WERSS_FEED_STALE:2026-07-19T10:00:00.000Z", "SOURCE_STALE"],
    ["TAVILY_API_KEY 未配置", "CONFIGURATION_ERROR"],
    ["ZLZCHAT_WXS_ID_REQUIRED:请填写 wxsId", "CONFIGURATION_ERROR"],
    ["ZLZCHAT_BASE_URL_UNSAFE", "CONFIGURATION_ERROR"],
    ["ZLZCHAT_PRIVATE_ORIGIN_NOT_ALLOWED", "CONFIGURATION_ERROR"],
    ["ZLZCHAT_REDIRECT_FORBIDDEN", "CONFIGURATION_ERROR"],
    ["ZLZCHAT_ALLOWED_ORIGINS_INVALID", "CONFIGURATION_ERROR"],
    ["X_USER_NOT_FOUND", "SOURCE_NOT_FOUND"],
    ["BUDGET_EXHAUSTED", "QUOTA_EXHAUSTED"],
  ])("maps %s to %s", (message, code) => {
    expect(classifyMonitorFailure(message).code).toBe(code);
  });

  it("only schedules quick retries for recoverable short-lived failures", () => {
    expect(classifyMonitorFailure("fetch failed").retryAfterMinutes).toBe(10);
    expect(classifyMonitorFailure("SUPERGROK_AUTH_EXPIRED").retryAfterMinutes).toBeUndefined();
    expect(classifyMonitorFailure("TAVILY_API_KEY 未配置").disableEligible).toBe(true);
  });

  it.each([
    "ZLZCHAT_BACKLOG_EXCEEDED",
  ])("retries transient coordination failure %s without auto-disabling the monitor", (message) => {
    expect(classifyMonitorFailure(message)).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      retryAfterMinutes: 10,
      disableEligible: false,
    });
  });

  it("treats an in-progress document analysis as an internal wait, not a monitor failure", () => {
    const failure = classifyMonitorFailure("DOCUMENT_ANALYSIS_IN_PROGRESS");
    expect(failure).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      retryAfterMinutes: 10,
      disableEligible: false,
      countsAsFailure: false,
    });
    expect(monitorFailureAccounting({
      currentFailureCount: 4,
      failure,
    })).toEqual({
      failureCount: 4,
      countForWorkerHealth: false,
    });
  });

  it("treats a lost lease as an internal retry, not a provider failure", () => {
    const failure = classifyMonitorFailure("LEASE_LOST: Monitor lease was taken by another worker");
    expect(failure).toMatchObject({
      code: "RUN_INTERRUPTED",
      retryable: true,
      retryAfterMinutes: 10,
      disableEligible: false,
      countsAsFailure: false,
    });
    expect(monitorFailureAccounting({ currentFailureCount: 4, failure })).toEqual({
      failureCount: 4,
      countForWorkerHealth: false,
    });
  });
});

describe("presentMonitorFailure", () => {
  it("turns technical WeRSS authorization failures into one concrete action", () => {
    expect(presentMonitorFailure({ message: "WERSS_RESOLVE_FAILED:401", platform: "wechat" })).toEqual({
      health: "需要授权",
      detail: "微信公众号授权已失效，请到“平台连接”重新扫码",
    });
  });

  it("uses the persisted stable code even when the raw provider message changes", () => {
    expect(presentMonitorFailure({ code: "NETWORK_ERROR", message: "vendor changed this text" }).health).toBe("网络异常");
  });
});
