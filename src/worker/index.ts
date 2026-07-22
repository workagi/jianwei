import { db } from "@/db";
import { monitors, collectionRuns, runtimeHealth, usageLedger } from "@/db/schema";
import { loadApiCredentials } from "@/db/queries";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ingest, createDrizzleIngestRepository } from "@/ingestion/ingest-items";
import type {
  NormalizedItem,
  PlatformType,
  CollectContext,
  WebSearchMonitorConfig,
} from "@/connectors/types";
import { isWechatKeywordRuleConfig } from "@/connectors/types";
import { createWorkerSourceProvider } from "@/sources/registry";
import { collectFromProvider } from "@/sources/types";
import { monitorStaggerKey, nextStaggeredRunAt } from "@/lib/monitor-schedule";
import { backfillMissingSummaries } from "@/lib/summary-backfill";
import { createWeRssConnector } from "@/connectors/factory";

// Cost per 1000 billable units. Brave's published rate is $3 / 1k queries; X has
// no stable public rate, so it defaults to 0 and can be overridden.
const BRAVE_COST_PER_1K = 3;
const X_COST_PER_1K_UNITS = Number(process.env.X_COST_PER_1K_UNITS ?? "0") || 0;
const MONTHLY_BUDGET_USD = Number(process.env.X_BRAVE_MONTHLY_BUDGET_USD);
const BUDGET_ENABLED = Number.isFinite(MONTHLY_BUDGET_USD) && MONTHLY_BUDGET_USD > 0;
const MONITOR_DISABLE_AFTER_FAILURES = Number(process.env.WORKER_DISABLE_MONITOR_AFTER_FAILURES ?? "5") || 0;
const WORKER_HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/jianwei-worker-heartbeat";
const WORKER_ID = process.env.WORKER_ID?.trim() || `${process.pid}-${randomUUID()}`;

interface GatherInput {
  platform: PlatformType;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
}

export interface GatherOutput {
  items: NormalizedItem[];
  cursor: Record<string, unknown>;
  billableUnits?: number;
}

/** Collect one monitor through the unified source-provider registry. */
export async function gather(input: GatherInput, context?: CollectContext): Promise<GatherOutput> {
  const provider = createWorkerSourceProvider(input.platform, input.config);
  return collectFromProvider(provider, input.config, input.cursor, context);
}

type MonitorRow = typeof monitors.$inferSelect;

/** Sum of estimated_cost (USD) for a connector since the 1st of the current month. */
async function monthlySpendUsd(connectorId: string): Promise<number> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const [row] = await db
    .select({ sum: sql<number>`coalesce(sum(${usageLedger.estimatedCost}), 0)` })
    .from(usageLedger)
    .where(and(eq(usageLedger.connectorId, connectorId), gte(usageLedger.occurredAt, start)));
  return Number(row?.sum ?? 0);
}

/** Throw BUDGET_EXHAUSTED if the connector's monthly spend has hit the cap. */
async function checkBudget(connectorId: string): Promise<void> {
  if (!BUDGET_ENABLED) return;
  const spent = await monthlySpendUsd(connectorId);
  if (spent >= MONTHLY_BUDGET_USD) throw new Error("BUDGET_EXHAUSTED");
}

/**
 * SuperGrok X Search burns subscription quota (not the USD Brave/X budget).
 * Soft daily cap stops a misconfigured fleet of 60-minute monitors from
 * emptying the quota before noon. 0 / unset = disabled.
 */
async function checkXGrokDailyBudget(): Promise<void> {
  const max = Number(process.env.XAI_X_SEARCH_DAILY_BUDGET);
  if (!Number.isFinite(max) || max <= 0) return;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [row] = await db
    .select({ sum: sql<number>`coalesce(sum(${usageLedger.quantity}), 0)` })
    .from(usageLedger)
    .where(and(eq(usageLedger.metric, "x_grok_searches"), gte(usageLedger.occurredAt, start)));
  if (Number(row?.sum ?? 0) >= max) throw new Error("XAI_X_SEARCH_DAILY_BUDGET_EXHAUSTED");
}

async function recordUsage(
  connectorId: string,
  monitorId: string,
  metric: string,
  quantity: number,
  estimatedCostUsd: number,
): Promise<void> {
  await db.insert(usageLedger).values({
    connectorId,
    monitorId,
    metric,
    quantity,
    estimatedCost: String(estimatedCostUsd),
  });
}

function summaryEstimatedCostUsd(inputTokens = 0, outputTokens = 0): number {
  const inputPrice = Number(process.env.SUMMARY_INPUT_COST_PER_1M_USD);
  const outputPrice = Number(process.env.SUMMARY_OUTPUT_COST_PER_1M_USD);
  const safeInputPrice = Number.isFinite(inputPrice) && inputPrice >= 0 ? inputPrice : 0;
  const safeOutputPrice = Number.isFinite(outputPrice) && outputPrice >= 0 ? outputPrice : 0;
  return (inputTokens / 1_000_000) * safeInputPrice + (outputTokens / 1_000_000) * safeOutputPrice;
}

function usefulWechatName(name: unknown): string | undefined {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed && trimmed !== "未知公众号" ? trimmed : undefined;
}

function isAutoWechatName(name: string): boolean {
  return name === "微信公众号" || name === "微信公众号识别中" || name === "mp.weixin.qq.com";
}

function isAutoXName(name: string, config: Record<string, unknown>): boolean {
  const username = typeof config.username === "string" ? config.username.replace(/^@/, "") : "";
  return Boolean(username) && (name === `@${username}` || name === username || name === "X / Twitter");
}

function resolvedWechatConfigPatch(cursor: Record<string, unknown>): Record<string, unknown> | null {
  const mpId = typeof cursor.mpId === "string" && cursor.mpId.trim() ? cursor.mpId.trim() : "";
  if (!mpId) return null;
  return {
    mpId,
    ...(typeof cursor.mpName === "string" && cursor.mpName.trim() ? { mpName: cursor.mpName.trim() } : {}),
    ...(typeof cursor.mpBiz === "string" && cursor.mpBiz.trim() ? { mpBiz: cursor.mpBiz.trim() } : {}),
    ...(typeof cursor.mpCover === "string" && cursor.mpCover.trim() ? { mpCover: cursor.mpCover.trim() } : {}),
    ...(typeof cursor.mpIntro === "string" && cursor.mpIntro.trim() ? { mpIntro: cursor.mpIntro.trim() } : {}),
  };
}

async function runMonitor(monitor: MonitorRow, shutdownSignal?: AbortSignal): Promise<void> {
  const [run] = await db
    .insert(collectionRuns)
    .values({ monitorId: monitor.id, status: "running" })
    .returning({ id: collectionRuns.id });
  const runId = run.id;
  const staggerKey = monitorStaggerKey({
    id: monitor.id,
    platform: monitor.platform,
    name: monitor.name,
    config: monitor.config,
  });
  let nextRunAt = nextStaggeredRunAt({
    intervalMinutes: monitor.pollIntervalMinutes,
    staggerKey,
  });

  try {
    // Billable platforms are gated by the monthly budget before any call.
    if ((monitor.platform === "x" && monitor.config.provider !== "x_grok") || monitor.platform === "web_search") {
      await checkBudget(monitor.connectorId);
    }
    // SuperGrok X Search has its own soft daily quota (subscription units).
    if (monitor.platform === "x" && monitor.config.provider === "x_grok") {
      await checkXGrokDailyBudget();
    }

    // 微信在「包含全文摘要」模式下会逐篇抓正文（by_article 约 15–30s/篇），
    // 用更宽松的超时预算，避免被通用 60s 一刀切中断。
    const gatherTimeout = monitor.platform === "wechat"
      ? WECHAT_GATHER_TIMEOUT_MS
      : monitor.platform === "x" && monitor.config.provider === "x_grok"
        ? X_GATHER_TIMEOUT_MS
        : GATHER_TIMEOUT_MS;
    const { items, cursor, billableUnits } = await withTimeout(
      (signal) => gather({
        platform: monitor.platform,
        config: monitor.config,
        cursor: monitor.cursor,
      }, { signal, runId, deadline: new Date(Date.now() + gatherTimeout) }),
      gatherTimeout,
      monitor.platform,
      shutdownSignal,
    );
    const result = await ingest(createDrizzleIngestRepository(), {
      items,
      monitorId: monitor.id,
    });
    const summaryInputTokens = result.summary.inputTokens ?? 0;
    const summaryOutputTokens = result.summary.outputTokens ?? 0;
    const summaryCost = summaryEstimatedCostUsd(summaryInputTokens, summaryOutputTokens);

    // Record cost/usage for billable platforms (WeChat cost is 0).
    if (monitor.platform === "x") {
      const units = billableUnits ?? 1;
      const grokSubscription = monitor.config.provider === "x_grok";
      await recordUsage(
        monitor.connectorId,
        monitor.id,
        grokSubscription ? "x_grok_searches" : "x_billable_units",
        units,
        grokSubscription ? 0 : (units / 1000) * X_COST_PER_1K_UNITS,
      );
    } else if (monitor.platform === "web_search") {
      const provider = ((monitor.config as WebSearchMonitorConfig).provider ?? "brave");
      await recordUsage(
        monitor.connectorId,
        monitor.id,
        `${provider}_queries`,
        billableUnits ?? 1,
        provider === "brave" ? BRAVE_COST_PER_1K / 1000 : 0,
      );
    }
    if (result.summary.attempted > 0) {
      const summaryUsage = [
        recordUsage(
          monitor.connectorId,
          monitor.id,
          "model_requests",
          result.summary.attempted,
          summaryCost,
        ),
      ];
      if (summaryInputTokens > 0) {
        summaryUsage.push(recordUsage(monitor.connectorId, monitor.id, "model_input_tokens", summaryInputTokens, 0));
      }
      if (summaryOutputTokens > 0) {
        summaryUsage.push(recordUsage(monitor.connectorId, monitor.id, "model_output_tokens", summaryOutputTokens, 0));
      }
      await Promise.all(summaryUsage);
    }

    const monitorUpdate: Partial<typeof monitors.$inferInsert> = {
      lastSuccessAt: new Date(),
      nextRunAt,
      failureCount: 0,
      lastError: null,
      cursor,
      leaseOwner: null,
      leaseUntil: null,
    };
    if (monitor.platform === "wechat" && !isWechatKeywordRuleConfig(monitor.config)) {
      const patch = resolvedWechatConfigPatch(cursor);
      const mpName = usefulWechatName(patch?.mpName);
      if (patch) {
        monitorUpdate.config = {
          ...(monitor.config ?? {}),
          ...patch,
        };
      }
      if (mpName && isAutoWechatName(monitor.name)) {
        monitorUpdate.name = mpName;
      }
    }
    if (monitor.platform === "x") {
      const profileName = typeof cursor.profileName === "string" ? cursor.profileName.trim() : "";
      if (profileName && isAutoXName(monitor.name, monitor.config)) monitorUpdate.name = profileName;
    }

    await db
      .update(monitors)
      .set(monitorUpdate)
      .where(and(eq(monitors.id, monitor.id), eq(monitors.leaseOwner, WORKER_ID)));

    await db
      .update(collectionRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        fetchedCount: items.length,
        insertedCount: result.itemsUpserted,
        matchedCount: result.matchesInserted,
        summaryStatus: result.summary.status,
        summaryAttemptedCount: result.summary.attempted,
        summarySucceededCount: result.summary.succeeded,
        summaryFailedCount: result.summary.failed,
        summaryErrorCode: result.summary.errorCode ?? null,
        summaryErrorMessage: result.summary.errorMessage ?? null,
        providerCost: String(summaryCost),
      })
      .where(eq(collectionRuns.id, runId));

    const summaryNote =
      result.summary.attempted > 0
        ? ` / summary ${result.summary.succeeded}/${result.summary.attempted} (${result.summary.status})`
        : "";
    console.log(`[worker] ${monitor.id}: +${result.itemsUpserted} items / ${result.matchesInserted} matches${summaryNote}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shutdownSignal?.aborted) {
      await Promise.all([
        db.update(monitors).set({ leaseOwner: null, leaseUntil: null }).where(and(
          eq(monitors.id, monitor.id),
          eq(monitors.leaseOwner, WORKER_ID),
        )),
        db.update(collectionRuns).set({
          status: "failed",
          finishedAt: new Date(),
          errorCode: "RUN_INTERRUPTED",
          errorMessage: "Worker stopped before this run finished.",
        }).where(eq(collectionRuns.id, runId)),
      ]);
      throw shutdownSignal.reason instanceof Error
        ? shutdownSignal.reason
        : new Error("WORKER_SHUTDOWN");
    }
    const failureCount = monitor.failureCount + 1;
    if (isTransientMonitorFailure(message)) {
      nextRunAt = nextStaggeredRunAt({ intervalMinutes: 10, staggerKey });
    }
    const shouldDisable = shouldDisableMonitorAfterFailure(failureCount, MONITOR_DISABLE_AFTER_FAILURES, message);
    await db
      .update(monitors)
      .set({
        failureCount,
        lastError: message,
        nextRunAt,
        leaseOwner: null,
        leaseUntil: null,
        ...(shouldDisable ? { enabled: false } : {}),
      })
      .where(and(eq(monitors.id, monitor.id), eq(monitors.leaseOwner, WORKER_ID)));

    await db
      .update(collectionRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorCode:
          message.startsWith("CONNECTOR") || message === "BUDGET_EXHAUSTED"
            ? message
            : "GATHER_FAILED",
        errorMessage: message,
      })
      .where(eq(collectionRuns.id, runId));

    console.warn(
      `[worker] ${monitor.id} 失败(${failureCount}/${MONITOR_DISABLE_AFTER_FAILURES || "∞"}): ${message}${
        shouldDisable ? "；已自动停用该监控" : ""
      }`,
    );
  }
}

export function shouldDisableMonitorAfterFailure(
  failureCount: number,
  threshold = MONITOR_DISABLE_AFTER_FAILURES,
  message = "",
): boolean {
  // Rate limits and upstream 5xx responses are recoverable service states, not
  // evidence that the user's monitor configuration is broken.
  if (isTransientMonitorFailure(message)) return false;
  if (/^WERSS_FEED_(?:STALE|NEVER_SYNCED)/.test(message)) return false;
  return threshold > 0 && failureCount >= threshold;
}

export function isTransientMonitorFailure(message: string): boolean {
  return /^XAI_X_SEARCH_(?:429|5\d\d|TIMEOUT|NETWORK(?::[A-Z0-9_]+)?)$/.test(message)
    || message === "XAI_X_SEARCH_DAILY_BUDGET_EXHAUSTED"
    || message === "GATHER_TIMEOUT:x"
    || message === "fetch failed";
}

// API 凭据键名（与 .env / factory.ts / summarizer.ts 保持一致）。
// worker 每轮采集前把它们从数据库刷新进 process.env，使后台保存后立即生效；
// DB 中未配置的键保留容器启动时的 env 值，且只同步已知键，避免误覆盖其他环境变量。
const CREDENTIAL_KEYS = [
  "X_BEARER_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY",
  "WERSS_ACCESS_KEY",
  "WECHAT_DIRECT_FALLBACK_ENABLED",
  "WECHAT_FALLBACK_BASE_URL",
  "SUMMARY_PROVIDER",
  "SUMMARY_BASE_URL",
  "SUMMARY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "ARK_API_KEY",
  "VOLCENGINE_API_KEY",
  "SUMMARY_MODEL",
  "SUMMARY_SKIP_PLATFORMS",
  "SUMMARY_MAX_INPUT_CHARS",
  "SUMMARY_MAX_CONCURRENCY",
  "SUMMARY_REQUESTS_PER_MINUTE",
  "SUMMARY_REQUEST_INTERVAL_MS",
  "SUMMARY_TIMEOUT_SECONDS",
  "SUMMARY_INPUT_COST_PER_1M_USD",
  "SUMMARY_OUTPUT_COST_PER_1M_USD",
];

async function refreshCredentials(): Promise<void> {
  try {
    const rows = await loadApiCredentials();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    for (const key of CREDENTIAL_KEYS) {
      const v = byKey.get(key);
      if (v !== undefined) process.env[key] = v;
    }
  } catch (err) {
    console.warn("[worker] 刷新 API 凭据失败:", err);
  }
}

const WERSS_TASK_REFRESH_INTERVAL_MS = 15 * 60_000;
let lastWeRssTaskRefreshAt = 0;
let lastWeRssAuthCheckAt = 0;

const WERSS_AUTH_CHECK_INTERVAL_MS = Math.max(
  1,
  Number(process.env.WERSS_AUTH_CHECK_INTERVAL_HOURS) || 6,
) * 60 * 60 * 1000;
const WERSS_AUTH_REFRESH_BEFORE_SECONDS = Math.max(
  1,
  Number(process.env.WERSS_AUTH_REFRESH_BEFORE_HOURS) || 48,
) * 60 * 60;

async function saveWeRssAuthHealth(
  status: "ok" | "warning" | "auth_required" | "error",
  detail: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  await db.insert(runtimeHealth).values({
    service: "werss_auth",
    status,
    lastHeartbeatAt: now,
    detail,
  }).onConflictDoUpdate({
    target: runtimeHealth.service,
    set: { status, lastHeartbeatAt: now, detail },
  });
}

async function maybeGuardWeRssAuthorization(now = Date.now()): Promise<void> {
  if (now - lastWeRssAuthCheckAt < WERSS_AUTH_CHECK_INTERVAL_MS) return;
  lastWeRssAuthCheckAt = now;
  const connector = createWeRssConnector();
  try {
    let session = await connector.sessionStatus();
    if (!session.authenticated) {
      await saveWeRssAuthHealth("auth_required", {
        account: session.account ?? null,
        expiryTimestamp: session.expiry_timestamp ?? null,
        remainingSeconds: session.remaining_seconds ?? 0,
        message: "微信公众号授权已失效，请打开 WeRSS 扫码恢复",
      });
      console.warn("[worker] WeRSS 微信授权已失效，需要重新扫码");
      return;
    }

    const remaining = typeof session.remaining_seconds === "number"
      ? session.remaining_seconds
      : null;
    let refreshed = false;
    if (remaining !== null && remaining <= WERSS_AUTH_REFRESH_BEFORE_SECONDS) {
      session = await connector.refreshSession();
      refreshed = true;
    }
    const nextRemaining = typeof session.remaining_seconds === "number"
      ? session.remaining_seconds
      : null;
    await saveWeRssAuthHealth(nextRemaining === null ? "warning" : "ok", {
      account: session.account ?? null,
      expiryTimestamp: session.expiry_timestamp ?? null,
      remainingSeconds: nextRemaining,
      refreshed,
      lastRefreshAt: refreshed ? new Date(now).toISOString() : null,
      message: nextRemaining === null ? "授权有效，但 WeRSS 未返回到期时间" : "微信公众号授权有效",
    });
    if (refreshed) console.log("[worker] WeRSS 微信授权已静默续期");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveWeRssAuthHealth("error", { message: message.slice(0, 300) });
    console.warn(`[worker] WeRSS 授权守护失败: ${message}`);
  }
}

async function maybeEnsureWeRssCollectionTask(now = Date.now()): Promise<void> {
  if (now - lastWeRssTaskRefreshAt < WERSS_TASK_REFRESH_INTERVAL_MS) return;
  const rows = await db
    .select({ name: monitors.name, config: monitors.config })
    .from(monitors)
    .where(and(eq(monitors.enabled, true), eq(monitors.platform, "wechat")));
  const feeds = rows.flatMap((row) => {
    if (isWechatKeywordRuleConfig(row.config)) return [];
    const mpId = typeof row.config.mpId === "string" ? row.config.mpId.trim() : "";
    if (!mpId) return [];
    const mpName = typeof row.config.mpName === "string" && row.config.mpName.trim()
      ? row.config.mpName.trim()
      : row.name;
    return [{ mpId, mpName }];
  });
  if (!feeds.length) {
    lastWeRssTaskRefreshAt = now;
    return;
  }
  const cron = process.env.WERSS_COLLECTION_CRON?.trim() || "17 */3 * * *";
  const result = await createWeRssConnector().ensureCollectionTask(feeds, cron);
  lastWeRssTaskRefreshAt = now;
  if (result.changed) {
    console.log(`[worker] 已同步 WeRSS 自动采集任务：${result.feedCount} 个公众号 (${cron})`);
  }
}

async function claimMonitor(monitor: MonitorRow, now = new Date()): Promise<boolean> {
  const [claimed] = await db
    .update(monitors)
    .set({
      leaseOwner: WORKER_ID,
      leaseUntil: new Date(now.getTime() + MONITOR_LEASE_MS),
    })
    .where(and(
      eq(monitors.id, monitor.id),
      eq(monitors.enabled, true),
      lte(monitors.nextRunAt, now),
      or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, now)),
    ))
    .returning({ id: monitors.id });
  return Boolean(claimed);
}

export async function runOnce(shutdownSignal?: AbortSignal): Promise<number> {
  // 每轮开始前刷新凭据，确保界面保存的密钥立即生效。
  await refreshCredentials();
  await maybeGuardWeRssAuthorization();
  try {
    await maybeEnsureWeRssCollectionTask();
  } catch (error) {
    console.warn(`[worker] 同步 WeRSS 自动采集任务失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  const due = await db
    .select()
    .from(monitors)
    .where(and(
      eq(monitors.enabled, true),
      lte(monitors.nextRunAt, new Date()),
      or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, new Date())),
    ));

  let claimedCount = 0;
  for (const monitor of due) {
    if (shutdownSignal?.aborted) break;
    if (!(await claimMonitor(monitor))) continue;
    claimedCount += 1;
    let leaseRenewalRunning = false;
    const leaseRenewalTimer = setInterval(() => {
      if (leaseRenewalRunning) return;
      leaseRenewalRunning = true;
      db.update(monitors).set({
        leaseUntil: new Date(Date.now() + MONITOR_LEASE_MS),
      }).where(and(
        eq(monitors.id, monitor.id),
        eq(monitors.leaseOwner, WORKER_ID),
      )).catch((error) => console.warn(`[worker] ${monitor.id} 租约续期失败:`, error))
        .finally(() => { leaseRenewalRunning = false; });
    }, Math.min(60_000, Math.max(5_000, Math.floor(MONITOR_LEASE_MS / 3))));
    try {
      await runMonitor(monitor, shutdownSignal);
    } finally {
      clearInterval(leaseRenewalTimer);
      // Also releases a lease if creating the collection_run itself failed.
      await db.update(monitors).set({ leaseOwner: null, leaseUntil: null }).where(and(
        eq(monitors.id, monitor.id),
        eq(monitors.leaseOwner, WORKER_ID),
      ));
    }
  }
  if (!shutdownSignal?.aborted) await maybeRetryFailedContentAnalysis();
  return claimedCount;
}

export async function markWorkerHeartbeat(now = new Date()): Promise<void> {
  await Promise.all([
    writeFile(WORKER_HEARTBEAT_FILE, now.toISOString(), "utf8"),
    db.insert(runtimeHealth).values({
      service: "worker",
      status: "ok",
      lastHeartbeatAt: now,
      detail: { pid: process.pid, workerId: WORKER_ID },
    }).onConflictDoUpdate({
      target: runtimeHealth.service,
      set: { status: "ok", lastHeartbeatAt: now, detail: { pid: process.pid, workerId: WORKER_ID } },
    }),
  ]);
}

// Poll interval: clamp to a sane minimum so a misconfigured 0 / negative
// value can't turn the loop into a busy-wait.
const rawPoll = Number(process.env.WORKER_POLL_INTERVAL_SECONDS);
const POLL_INTERVAL_MS = Math.max(5, Number.isFinite(rawPoll) && rawPoll > 0 ? rawPoll : 60) * 1000;

// Per-gather hard timeout. A single connector that hangs (slow X API, wedged
// WeRSS/TrendRadar MCP) must not block the whole poll cycle and starve the
// other due monitors.
const GATHER_TIMEOUT_MS = (Number(process.env.WORKER_GATHER_TIMEOUT_SECONDS) || 60) * 1000;
// SuperGrok / X Search 自身允许接近 55 秒；给连接重试和响应解析留出余量，
// 避免外层通用 60 秒比连接器先结束而吞掉可理解的错误状态。
const X_GATHER_TIMEOUT_MS = (Number(process.env.WORKER_X_GATHER_TIMEOUT_SECONDS) || 70) * 1000;
// 微信公众号在「包含全文摘要」模式下会逐篇抓取文章正文（by_article 约 15–30s/篇），
// 需要比通用采集更长的超时预算，否则会被通用 60s 一刀切中断。
const WECHAT_GATHER_TIMEOUT_MS = (Number(process.env.WORKER_WECHAT_GATHER_TIMEOUT_SECONDS) || 180) * 1000;
const MONITOR_LEASE_MS = Math.max(
  5 * 60_000,
  (Number(process.env.WORKER_MONITOR_LEASE_SECONDS) || 30 * 60) * 1000,
);
const CONTENT_RETRY_INTERVAL_MS = (Number(process.env.CONTENT_RETRY_INTERVAL_MINUTES) || 15) * 60_000;
const CONTENT_RETRY_BATCH_SIZE = Math.max(1, Number(process.env.CONTENT_RETRY_BATCH_SIZE) || 5);
const CONTENT_RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.CONTENT_RETRY_MAX_ATTEMPTS) || 5);
let lastContentRetryAt = 0;

async function maybeRetryFailedContentAnalysis(now = Date.now()): Promise<void> {
  if (now - lastContentRetryAt < CONTENT_RETRY_INTERVAL_MS) return;
  lastContentRetryAt = now;
  try {
    // Only retry hard failures. Do NOT auto-backfill historical empty summaries —
    // new rows are analyzed at ingest, and TrendRadar now uses the same gate as
    // the reader so hidden hotlist noise never enters the model path.
    const result = await backfillMissingSummaries(CONTENT_RETRY_BATCH_SIZE, {
      scope: "failures",
      retryAfterMinutes: CONTENT_RETRY_INTERVAL_MS / 60_000,
      maxAttempts: CONTENT_RETRY_MAX_ATTEMPTS,
    });
    if (result.processed > 0) {
      console.log(
        `[worker] 模型理解失败重试 ${result.processed} 条，成功 ${result.stats.succeeded}/${result.stats.attempted}`,
      );
    }
  } catch (error) {
    console.warn("[worker] 模型理解自动重试失败:", error);
  }
}

export async function cleanupStaleRunningRuns(): Promise<number> {
  const staleAfterMs = Math.max(GATHER_TIMEOUT_MS, WECHAT_GATHER_TIMEOUT_MS) + 60_000;
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(collectionRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      errorCode: "RUN_INTERRUPTED",
      errorMessage: "Worker restarted or stopped before this run finished.",
    })
    .where(and(eq(collectionRuns.status, "running"), lte(collectionRuns.startedAt, cutoff)))
    .returning({ id: collectionRuns.id });
  return rows.length;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`GATHER_TIMEOUT:${label}`);
  const timer = setTimeout(() => controller.abort(timeoutError), ms);
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  try {
    return await operation(signal);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    if (parentSignal?.aborted) throw parentSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let stopped = false;
  const shutdownController = new AbortController();
  const stop = () => {
    stopped = true;
    if (!shutdownController.signal.aborted) {
      shutdownController.abort(new Error("WORKER_SHUTDOWN"));
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[worker] 启动采集循环，间隔 ${POLL_INTERVAL_MS / 1000}s`);
  await markWorkerHeartbeat();
  let heartbeatRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    markWorkerHeartbeat()
      .catch((error) => console.warn("[worker] 心跳更新失败:", error))
      .finally(() => { heartbeatRunning = false; });
  }, 15_000);
  try {
    const cleaned = await cleanupStaleRunningRuns();
    if (cleaned) console.warn(`[worker] 已清理 ${cleaned} 条中断的运行记录`);
  } catch (err) {
    console.warn("[worker] 清理中断运行记录失败:", err);
  }
  while (!stopped) {
    try {
      const count = await runOnce(shutdownController.signal);
      await markWorkerHeartbeat();
      console.log(`[worker] 处理 ${count} 个到期监控任务`);
    } catch (err) {
      console.error("[worker] runOnce 异常:", err);
    }
    // 以 1s 粒度等待，便于收到 SIGTERM 时快速退出。
    const deadline = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < deadline && !stopped) await sleep(1000);
  }
  clearInterval(heartbeatTimer);
  console.log("[worker] 已停止");
}

// Only run the loop when invoked directly (e.g. `pnpm worker`). When imported
// by unit tests, this must not execute.
if (process.argv[1] && /worker\/index\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[worker] 致命错误:", err);
    process.exit(1);
  });
}
