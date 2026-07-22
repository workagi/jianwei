import { db } from "@/db";
import { monitors, collectionRuns, runtimeHealth, usageLedger } from "@/db/schema";
import { loadApiCredentials } from "@/db/queries";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  commitPreparedIngest,
  createDrizzleIngestRepository,
  prepareIngest,
} from "@/ingestion/ingest-items";
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
import {
  releaseUsageReservation,
  reserveUsageBudget,
  settleUsageReservation,
  type UsageBudgetReservation,
} from "@/lib/usage-budget";
import { createStructuredLogger } from "@/lib/structured-log";
import { classifyMonitorFailure } from "@/lib/monitor-error";

// Cost per 1000 billable units. Brave's published rate is $3 / 1k queries; X has
// no stable public rate, so it defaults to 0 and can be overridden.
const BRAVE_COST_PER_1K = 3;
const X_COST_PER_1K_UNITS = Number(process.env.X_COST_PER_1K_UNITS ?? "0") || 0;
// One official-X collection resolves the user once and can read up to 100 posts.
// Reserve the worst case so concurrent workers cannot push the monthly cap over
// its configured ceiling; successful runs still record their actual units.
const X_OFFICIAL_MAX_BILLABLE_UNITS = 101;
const MONTHLY_BUDGET_USD = Number(process.env.X_BRAVE_MONTHLY_BUDGET_USD);
const BUDGET_ENABLED = Number.isFinite(MONTHLY_BUDGET_USD) && MONTHLY_BUDGET_USD > 0;
const MONITOR_DISABLE_AFTER_FAILURES = Number(process.env.WORKER_DISABLE_MONITOR_AFTER_FAILURES ?? "5") || 0;
const WORKER_HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/jianwei-worker-heartbeat";
const WORKER_ID = process.env.WORKER_ID?.trim() || `${process.pid}-${randomUUID()}`;
const workerLog = createStructuredLogger({ service: "worker", workerId: WORKER_ID });

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
type WorkerDatabase = Pick<typeof db, "insert" | "update">;

export function collectionRunIdempotencyKey(monitorId: string, scheduledFor: Date): string {
  return `monitor:${monitorId}:${scheduledFor.toISOString()}`;
}

export function usageIdempotencyKey(runKey: string, metric: string): string {
  return `${runKey}:usage:${metric}`;
}

async function recordUsage(
  database: WorkerDatabase,
  runKey: string,
  connectorId: string,
  monitorId: string,
  metric: string,
  quantity: number,
  estimatedCostUsd: number,
): Promise<void> {
  await database.insert(usageLedger).values({
    idempotencyKey: usageIdempotencyKey(runKey, metric),
    connectorId,
    monitorId,
    metric,
    quantity,
    estimatedCost: String(estimatedCostUsd),
  }).onConflictDoNothing({ target: usageLedger.idempotencyKey });
}

function budgetReservationForMonitor(
  monitor: MonitorRow,
  runKey: string,
): UsageBudgetReservation | null {
  if (monitor.platform === "x" && monitor.config.provider === "x_grok") {
    const limit = Number(process.env.XAI_X_SEARCH_DAILY_BUDGET);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const metric = "x_grok_searches";
    return {
      idempotencyKey: usageIdempotencyKey(runKey, metric),
      scopeKey: `daily:${metric}`,
      connectorId: monitor.connectorId,
      monitorId: monitor.id,
      metric,
      quantity: 1,
      estimatedCostUsd: 0,
      kind: "daily_quantity",
      limit,
      exhaustedError: "XAI_X_SEARCH_DAILY_BUDGET_EXHAUSTED",
    };
  }

  if (!BUDGET_ENABLED) return null;
  if (monitor.platform === "x") {
    const estimatedCostUsd = (X_OFFICIAL_MAX_BILLABLE_UNITS / 1000) * X_COST_PER_1K_UNITS;
    if (estimatedCostUsd <= 0) return null;
    const metric = "x_billable_units";
    return {
      idempotencyKey: usageIdempotencyKey(runKey, metric),
      scopeKey: `monthly-cost:${monitor.connectorId}`,
      connectorId: monitor.connectorId,
      monitorId: monitor.id,
      metric,
      quantity: X_OFFICIAL_MAX_BILLABLE_UNITS,
      estimatedCostUsd,
      kind: "monthly_cost",
      limit: MONTHLY_BUDGET_USD,
      exhaustedError: "BUDGET_EXHAUSTED",
    };
  }
  if (monitor.platform === "web_search") {
    const provider = ((monitor.config as WebSearchMonitorConfig).provider ?? "brave");
    const estimatedCostUsd = provider === "brave" ? BRAVE_COST_PER_1K / 1000 : 0;
    if (estimatedCostUsd <= 0) return null;
    const metric = `${provider}_queries`;
    return {
      idempotencyKey: usageIdempotencyKey(runKey, metric),
      scopeKey: `monthly-cost:${monitor.connectorId}`,
      connectorId: monitor.connectorId,
      monitorId: monitor.id,
      metric,
      quantity: 1,
      estimatedCostUsd,
      kind: "monthly_cost",
      limit: MONTHLY_BUDGET_USD,
      exhaustedError: "BUDGET_EXHAUSTED",
    };
  }
  return null;
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

function monitorMatchedQuery(monitor: MonitorRow): string | undefined {
  if (monitor.platform === "x") {
    const username = typeof monitor.config.username === "string" ? monitor.config.username.replace(/^@/, "").trim() : "";
    return username ? `@${username}` : undefined;
  }
  if (monitor.platform === "web_search") {
    return typeof monitor.config.query === "string" ? monitor.config.query.trim() || undefined : undefined;
  }
  if (monitor.platform === "wechat") {
    if (isWechatKeywordRuleConfig(monitor.config)) return monitor.config.query;
    const name = typeof monitor.config.mpName === "string" ? monitor.config.mpName.trim() : "";
    return name || monitor.name;
  }
  return monitor.name;
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

async function startCollectionRun(monitor: MonitorRow): Promise<{
  runId: string;
  runKey: string;
  alreadySucceeded: boolean;
}> {
  const scheduledFor = monitor.nextRunAt;
  const runKey = collectionRunIdempotencyKey(monitor.id, scheduledFor);
  const [created] = await db
    .insert(collectionRuns)
    .values({
      monitorId: monitor.id,
      scheduledFor,
      idempotencyKey: runKey,
      status: "running",
    })
    .onConflictDoNothing({ target: collectionRuns.idempotencyKey })
    .returning({ id: collectionRuns.id });
  if (created) return { runId: created.id, runKey, alreadySucceeded: false };

  const [existing] = await db
    .select({
      id: collectionRuns.id,
      status: collectionRuns.status,
    })
    .from(collectionRuns)
    .where(eq(collectionRuns.idempotencyKey, runKey))
    .limit(1);
  if (!existing) throw new Error("COLLECTION_RUN_IDEMPOTENCY_CONFLICT");
  if (existing.status === "success") {
    return { runId: existing.id, runKey, alreadySucceeded: true };
  }

  await db
    .update(collectionRuns)
    .set({
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      attempt: sql`${collectionRuns.attempt} + 1`,
    })
    .where(eq(collectionRuns.id, existing.id));
  return { runId: existing.id, runKey, alreadySucceeded: false };
}

async function runMonitor(monitor: MonitorRow, shutdownSignal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const { runId, runKey, alreadySucceeded } = await startCollectionRun(monitor);
  const runLog = workerLog.child({
    runId,
    runKey,
    monitorId: monitor.id,
    connectorId: monitor.connectorId,
    platform: monitor.platform,
    provider: typeof monitor.config.provider === "string" ? monitor.config.provider : undefined,
  });
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

  if (alreadySucceeded) {
    await db.update(monitors).set({
      nextRunAt,
      leaseOwner: null,
      leaseUntil: null,
    }).where(and(eq(monitors.id, monitor.id), eq(monitors.leaseOwner, WORKER_ID)));
    runLog.info("collection.skipped", {
      reason: "already_succeeded",
      durationMs: Date.now() - startedAt,
      nextRunAt,
    });
    return;
  }

  let budgetReservationKey: string | undefined;
  try {
    runLog.info("collection.started", {
      scheduledFor: monitor.nextRunAt,
      pollIntervalMinutes: monitor.pollIntervalMinutes,
    });
    // Reserve provider budget before the external call. The database lock in
    // reserveUsageBudget makes concurrent workers participate in one budget.
    const budgetReservation = budgetReservationForMonitor(monitor, runKey);
    if (budgetReservation) {
      budgetReservationKey = budgetReservation.idempotencyKey;
      const reservationStatus = await reserveUsageBudget(budgetReservation);
      if (reservationStatus === "settled") {
        throw new Error("USAGE_RESERVATION_ALREADY_SETTLED");
      }
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
    // Provider and model work stays outside a database transaction. Only the
    // final durable state is committed atomically below.
    const prepared = await prepareIngest(createDrizzleIngestRepository(), {
      items,
      monitorId: monitor.id,
      matchedQuery: monitorMatchedQuery(monitor),
    });
    const summaryInputTokens = prepared.summary.inputTokens ?? 0;
    const summaryOutputTokens = prepared.summary.outputTokens ?? 0;
    const summaryCost = summaryEstimatedCostUsd(summaryInputTokens, summaryOutputTokens);

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

    const result = await db.transaction(async (tx) => {
      const committed = await commitPreparedIngest(createDrizzleIngestRepository(tx), prepared);

      // Usage rows share the run's idempotency key. A retried commit can never
      // count the same provider/model metric twice.
      if (monitor.platform === "x") {
        const units = billableUnits ?? 1;
        const grokSubscription = monitor.config.provider === "x_grok";
        await recordUsage(
          tx,
          runKey,
          monitor.connectorId,
          monitor.id,
          grokSubscription ? "x_grok_searches" : "x_billable_units",
          units,
          grokSubscription ? 0 : (units / 1000) * X_COST_PER_1K_UNITS,
        );
        await settleUsageReservation(tx, budgetReservationKey);
      } else if (monitor.platform === "web_search") {
        const provider = ((monitor.config as WebSearchMonitorConfig).provider ?? "brave");
        await recordUsage(
          tx,
          runKey,
          monitor.connectorId,
          monitor.id,
          `${provider}_queries`,
          billableUnits ?? 1,
          provider === "brave" ? BRAVE_COST_PER_1K / 1000 : 0,
        );
        await settleUsageReservation(tx, budgetReservationKey);
      }
      if (committed.summary.attempted > 0) {
        await recordUsage(
          tx,
          runKey,
          monitor.connectorId,
          monitor.id,
          "model_requests",
          committed.summary.attempted,
          summaryCost,
        );
        if (summaryInputTokens > 0) {
          await recordUsage(tx, runKey, monitor.connectorId, monitor.id, "model_input_tokens", summaryInputTokens, 0);
        }
        if (summaryOutputTokens > 0) {
          await recordUsage(tx, runKey, monitor.connectorId, monitor.id, "model_output_tokens", summaryOutputTokens, 0);
        }
      }

      await tx
        .update(monitors)
        .set(monitorUpdate)
        .where(and(eq(monitors.id, monitor.id), eq(monitors.leaseOwner, WORKER_ID)));

      await tx
        .update(collectionRuns)
        .set({
          status: "success",
          finishedAt: new Date(),
          fetchedCount: items.length,
          insertedCount: committed.itemsUpserted,
          matchedCount: committed.matchesInserted,
          summaryStatus: committed.summary.status,
          summaryAttemptedCount: committed.summary.attempted,
          summarySucceededCount: committed.summary.succeeded,
          summaryFailedCount: committed.summary.failed,
          summaryErrorCode: committed.summary.errorCode ?? null,
          summaryErrorMessage: committed.summary.errorMessage ?? null,
          providerCost: String(summaryCost),
        })
        .where(eq(collectionRuns.id, runId));
      return committed;
    });

    runLog.info("collection.succeeded", {
      durationMs: Date.now() - startedAt,
      fetchedCount: items.length,
      itemsUpserted: result.itemsUpserted,
      matchesInserted: result.matchesInserted,
      billableUnits: billableUnits ?? null,
      summaryStatus: result.summary.status,
      summaryAttempted: result.summary.attempted,
      summarySucceeded: result.summary.succeeded,
      summaryFailed: result.summary.failed,
      summaryInputTokens,
      summaryOutputTokens,
      summaryEstimatedCostUsd: summaryCost,
      nextRunAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shutdownSignal?.aborted) {
      await db.transaction(async (tx) => {
        await releaseUsageReservation(tx, budgetReservationKey);
        await tx.update(monitors).set({ leaseOwner: null, leaseUntil: null }).where(and(
          eq(monitors.id, monitor.id),
          eq(monitors.leaseOwner, WORKER_ID),
        ));
        await tx.update(collectionRuns).set({
          status: "failed",
          finishedAt: new Date(),
          errorCode: "RUN_INTERRUPTED",
          errorMessage: "Worker stopped before this run finished.",
        }).where(eq(collectionRuns.id, runId));
      });
      throw shutdownSignal.reason instanceof Error
        ? shutdownSignal.reason
        : new Error("WORKER_SHUTDOWN");
    }
    const budgetRetryAt = nextBudgetRetryAt(message);
    const failure = classifyMonitorFailure(message);
    const failureCount = budgetRetryAt ? monitor.failureCount : monitor.failureCount + 1;
    if (budgetRetryAt) {
      nextRunAt = budgetRetryAt;
    } else if (failure.retryAfterMinutes) {
      nextRunAt = nextStaggeredRunAt({ intervalMinutes: failure.retryAfterMinutes, staggerKey });
    }
    const shouldDisable = shouldDisableMonitorAfterFailure(failureCount, MONITOR_DISABLE_AFTER_FAILURES, message);
    const errorCode = failure.code;
    await db.transaction(async (tx) => {
      await releaseUsageReservation(tx, budgetReservationKey);
      await tx
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

      await tx
        .update(collectionRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorCode,
          errorMessage: message,
        })
        .where(eq(collectionRuns.id, runId));
    });

    runLog.warn("collection.failed", {
      durationMs: Date.now() - startedAt,
      errorCode,
      errorMessage: message,
      failureCount,
      disableThreshold: MONITOR_DISABLE_AFTER_FAILURES || null,
      monitorDisabled: shouldDisable,
      transient: isTransientMonitorFailure(message),
      budgetExhausted: isBudgetExhaustion(message),
      nextRunAt,
    });
  }
}

export function shouldDisableMonitorAfterFailure(
  failureCount: number,
  threshold = MONITOR_DISABLE_AFTER_FAILURES,
  message = "",
): boolean {
  return threshold > 0
    && failureCount >= threshold
    && classifyMonitorFailure(message).disableEligible;
}

export function isTransientMonitorFailure(message: string): boolean {
  return Boolean(classifyMonitorFailure(message).retryAfterMinutes);
}

export function isBudgetExhaustion(message: string): boolean {
  return message === "BUDGET_EXHAUSTED"
    || message === "XAI_X_SEARCH_DAILY_BUDGET_EXHAUSTED";
}

/**
 * Budget exhaustion is a planned pause, not a connector failure. Resume shortly
 * after the next local billing window starts instead of retrying every 10 minutes.
 */
export function nextBudgetRetryAt(message: string, now = new Date()): Date | null {
  if (!isBudgetExhaustion(message)) return null;
  const retryAt = new Date(now);
  retryAt.setHours(0, 15, 0, 0);
  if (message === "XAI_X_SEARCH_DAILY_BUDGET_EXHAUSTED") {
    retryAt.setDate(retryAt.getDate() + 1);
  } else {
    retryAt.setMonth(retryAt.getMonth() + 1, 1);
  }
  return retryAt;
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
    workerLog.warn("credentials.refresh.failed", { error: err });
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
      workerLog.warn("werss.authorization.required", {
        account: session.account ?? null,
        expiryTimestamp: session.expiry_timestamp ?? null,
      });
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
    if (refreshed) {
      workerLog.info("werss.authorization.refreshed", {
        account: session.account ?? null,
        expiryTimestamp: session.expiry_timestamp ?? null,
        remainingSeconds: nextRemaining,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveWeRssAuthHealth("error", { message: message.slice(0, 300) });
    workerLog.warn("werss.authorization.guard_failed", { errorMessage: message });
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
    workerLog.info("werss.collection_task.synced", { feedCount: result.feedCount, cron });
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
    workerLog.warn("werss.collection_task.sync_failed", { error });
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
      )).catch((error) => workerLog.warn("monitor.lease_renewal.failed", {
        monitorId: monitor.id,
        platform: monitor.platform,
        error,
      }))
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
      workerLog.info("analysis.retry.completed", {
        processed: result.processed,
        attempted: result.stats.attempted,
        succeeded: result.stats.succeeded,
        failed: result.stats.failed,
        status: result.stats.status,
      });
    }
  } catch (error) {
    workerLog.warn("analysis.retry.failed", { error });
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

  workerLog.info("worker.started", {
    pid: process.pid,
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    monitorLeaseSeconds: MONITOR_LEASE_MS / 1000,
  });
  await markWorkerHeartbeat();
  let heartbeatRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    markWorkerHeartbeat()
      .catch((error) => workerLog.warn("worker.heartbeat.failed", { error }))
      .finally(() => { heartbeatRunning = false; });
  }, 15_000);
  try {
    const cleaned = await cleanupStaleRunningRuns();
    if (cleaned) workerLog.warn("collection.stale_runs.cleaned", { cleaned });
  } catch (err) {
    workerLog.warn("collection.stale_runs.cleanup_failed", { error: err });
  }
  while (!stopped) {
    try {
      const count = await runOnce(shutdownController.signal);
      await markWorkerHeartbeat();
      workerLog.info("worker.poll.completed", { claimedMonitorCount: count });
    } catch (err) {
      workerLog.error("worker.poll.failed", { error: err });
    }
    // 以 1s 粒度等待，便于收到 SIGTERM 时快速退出。
    const deadline = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < deadline && !stopped) await sleep(1000);
  }
  clearInterval(heartbeatTimer);
  workerLog.info("worker.stopped");
}

// Only run the loop when invoked directly (e.g. `pnpm worker`). When imported
// by unit tests, this must not execute.
if (process.argv[1] && /worker\/index\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    workerLog.error("worker.fatal", { error: err });
    process.exit(1);
  });
}
