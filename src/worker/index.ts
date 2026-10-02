import { db, sql as postgresClient } from "@/db";
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
import { extractMonitorRulesFromConfig } from "@/lib/monitor-rules";
import { isWechatKeywordRuleConfig } from "@/connectors/types";
import { createWorkerSourceProvider } from "@/sources/registry";
import { collectFromProvider } from "@/sources/types";
import { monitorStaggerKey, nextStaggeredRunAt } from "@/lib/monitor-schedule";
import { backfillMissingSummaries } from "@/lib/summary-backfill";
import { refreshEventProjection } from "@/lib/event-projection";
import { createWeRssConnector } from "@/connectors/factory";
import {
  releaseUsageReservation,
  reserveUsageBudget,
  settleUsageReservation,
  type UsageBudgetReservation,
} from "@/lib/usage-budget";
import { createStructuredLogger } from "@/lib/structured-log";
import {
  classifyMonitorFailure,
  monitorFailureAccounting,
} from "@/lib/monitor-error";
import {
  claimMonitor,
  getLeaseWorkerId,
  getMonitorLeaseMs,
  getWorkerHealthService,
  retryLeaseRenewal,
  type ClaimedMonitor,
} from "./lease-manager";
import {
  cleanupStaleRunningRuns,
  staleRunReaperIntervalMs,
} from "./stale-run-reaper";
import { deriveWorkerRuntimeStatus } from "@/lib/system-health";
import { HISTORY_PRUNE_BATCH_SIZE, pruneOperationalHistory } from "./maintenance";

// Cost per 1000 billable units. Brave's published rate is $3 / 1k queries; X has
// no stable public rate, so it defaults to 0 and can be overridden.
const BRAVE_COST_PER_1K = 3;
const X_COST_PER_1K_UNITS = Number(process.env.X_COST_PER_1K_UNITS ?? "0") || 0;
// One official-X collection resolves the user once and can read up to 100 posts
// per configured page. Reserve the true ceiling used by the connector.
// Reserve the worst case so concurrent workers cannot push the monthly cap over
// its configured ceiling; successful runs still record their actual units.
const configuredXMaxPages = Number(process.env.X_API_MAX_PAGES ?? "20");
const X_OFFICIAL_MAX_BILLABLE_UNITS = 1 + 100 * (
  Number.isFinite(configuredXMaxPages)
    ? Math.min(100, Math.max(1, Math.floor(configuredXMaxPages)))
    : 20
);
const MONTHLY_BUDGET_USD = Number(process.env.X_BRAVE_MONTHLY_BUDGET_USD);
const BUDGET_ENABLED = Number.isFinite(MONTHLY_BUDGET_USD) && MONTHLY_BUDGET_USD > 0;
const MONITOR_DISABLE_AFTER_FAILURES = Number(process.env.WORKER_DISABLE_MONITOR_AFTER_FAILURES ?? "5") || 0;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? "2") || 0);
const WORKER_HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/jianwei-worker-heartbeat";
const WORKER_DEGRADED_AFTER_POLL_FAILURES = Math.max(
  1,
  Number(process.env.WORKER_DEGRADED_AFTER_POLL_FAILURES) || 3,
);
const WORKER_DEGRADED_AFTER_COLLECTION_FAILURES = Math.max(
  1,
  Number(process.env.WORKER_DEGRADED_AFTER_COLLECTION_FAILURES) || 3,
);
const workerLog = createStructuredLogger({ service: "worker", workerId: getLeaseWorkerId() });
let pollStartedAt: Date | null = null;
let lastPollStartedAt: Date | null = null;
let lastPollCompletedAt: Date | null = null;
let lastSuccessfulPollAt: Date | null = null;
let lastPollErrorName: string | null = null;
let consecutivePollFailures = 0;
let lastCollectionSuccessAt: Date | null = null;
let lastCollectionFailureAt: Date | null = null;
let consecutiveCollectionFailures = 0;

function recordCollectionSuccess(now = new Date()): void {
  lastCollectionSuccessAt = now;
  consecutiveCollectionFailures = 0;
}

function recordCollectionFailure(now = new Date()): void {
  lastCollectionFailureAt = now;
  consecutiveCollectionFailures += 1;
}

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
  attemptToken: string,
): UsageBudgetReservation | null {
  if (monitor.platform === "x" && monitor.config.provider === "x_grok") {
    const limit = Number(process.env.XAI_X_SEARCH_DAILY_BUDGET);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const metric = "x_grok_searches";
    return {
      idempotencyKey: usageIdempotencyKey(runKey, metric),
      reservationToken: attemptToken,
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
      reservationToken: attemptToken,
      scopeKey: "monthly-cost:x-brave",
      connectorId: monitor.connectorId,
      monitorId: monitor.id,
      metric,
      scopeMetrics: ["x_billable_units", "brave_queries"],
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
      reservationToken: attemptToken,
      scopeKey: "monthly-cost:x-brave",
      connectorId: monitor.connectorId,
      monitorId: monitor.id,
      metric,
      scopeMetrics: ["x_billable_units", "brave_queries"],
      quantity: 1,
      estimatedCostUsd,
      kind: "monthly_cost",
      limit: MONTHLY_BUDGET_USD,
      exhaustedError: "BUDGET_EXHAUSTED",
    };
  }
  return null;
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

export async function startCollectionRun(monitor: Pick<ClaimedMonitor, "id" | "nextRunAt" | "leaseEpoch">): Promise<{
  runId: string;
  runKey: string;
  attemptToken: string;
  alreadySucceeded: boolean;
}> {
  const scheduledFor = monitor.nextRunAt;
  const mid = monitor.id;
  const runKey = collectionRunIdempotencyKey(mid, scheduledFor);
  const attemptToken = `${monitor.leaseEpoch}:${randomUUID()}`;

  return db.transaction(async (tx) => {
    // Lock and re-assert the monitor lease before creating or taking over a
    // run. This closes the window where an expired worker could replace the
    // current attempt token before its first fenced business transaction.
    const [owned] = await tx
      .update(monitors)
      .set({ leaseUntil: new Date(Date.now() + getMonitorLeaseMs()) })
      .where(and(
        eq(monitors.id, mid),
        eq(monitors.leaseOwner, getLeaseWorkerId()),
        eq(monitors.leaseEpoch, monitor.leaseEpoch),
      ))
      .returning({ id: monitors.id });
    if (!owned) throw new Error("LEASE_LOST: Cannot start collection run");

    const [created] = await tx
      .insert(collectionRuns)
      .values({
        monitorId: mid,
        scheduledFor,
        idempotencyKey: runKey,
        attemptToken,
        status: "running",
      })
      .onConflictDoNothing({ target: collectionRuns.idempotencyKey })
      .returning({ id: collectionRuns.id });
    if (created) return { runId: created.id, runKey, attemptToken, alreadySucceeded: false };

    const [existing] = await tx
      .select({
        id: collectionRuns.id,
        status: collectionRuns.status,
        attemptToken: collectionRuns.attemptToken,
      })
      .from(collectionRuns)
      .where(eq(collectionRuns.idempotencyKey, runKey))
      .limit(1);
    if (!existing) throw new Error("COLLECTION_RUN_IDEMPOTENCY_CONFLICT");
    if (existing.status === "success") {
      return { runId: existing.id, runKey, attemptToken: existing.attemptToken, alreadySucceeded: true };
    }

    const existingEpoch = Number(existing.attemptToken.split(":", 1)[0]);
    if (existing.status === "running" && existingEpoch === monitor.leaseEpoch) {
      throw new Error("COLLECTION_RUN_ALREADY_CLAIMED");
    }

    // CAS: only a newer monitor lease may take over an unfinished attempt.
    const [updated] = await tx
      .update(collectionRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        attemptToken,
        attempt: sql`${collectionRuns.attempt} + 1`,
      })
      .where(and(
        eq(collectionRuns.id, existing.id),
        eq(collectionRuns.status, existing.status),
        eq(collectionRuns.attemptToken, existing.attemptToken),
      ))
      .returning({ id: collectionRuns.id });
    if (!updated) throw new Error("COLLECTION_RUN_ALREADY_CLAIMED");
    return { runId: existing.id, runKey, attemptToken, alreadySucceeded: false };
  });
}

function isLeaseLossAbort(signal?: AbortSignal): boolean {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /LEASE_(?:LOST|RENEWAL_UNCONFIRMED)/i.test(message);
}

async function runMonitor(
  claimed: ClaimedMonitor,
  claimedEpoch: number,
  taskSignal?: AbortSignal,
  globalShutdownSignal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  const { runId, runKey, attemptToken, alreadySucceeded } = await startCollectionRun(claimed);
  const runLog = workerLog.child({
    runId,
    runKey,
    attemptToken,
    monitorId: claimed.monitorId,
    connectorId: claimed.connectorId,
    platform: claimed.platform,
    provider: typeof claimed.config.provider === "string" ? claimed.config.provider : undefined,
  });
  const staggerKey = monitorStaggerKey({
    id: claimed.monitorId,
    platform: claimed.platform,
    name: claimed.name,
    config: claimed.config,
  });
  let nextRunAt = nextStaggeredRunAt({
    intervalMinutes: claimed.pollIntervalMinutes,
    staggerKey,
  });

  if (alreadySucceeded) {
    await markRunProgress(runId, attemptToken, "skipped");
    await db.update(monitors).set({
      nextRunAt,
      leaseOwner: null,
      leaseUntil: null,
    }).where(and(eq(monitors.id, claimed.id), eq(monitors.leaseOwner, getLeaseWorkerId()), eq(monitors.leaseEpoch, claimedEpoch)));
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
      scheduledFor: claimed.nextRunAt,
      pollIntervalMinutes: claimed.pollIntervalMinutes,
    });
    // Reserve provider budget before the external call. The database lock in
    // reserveUsageBudget makes concurrent workers participate in one budget.
    const budgetReservation = budgetReservationForMonitor(claimed, runKey, attemptToken);
    if (budgetReservation) {
      budgetReservationKey = budgetReservation.idempotencyKey;
      const reservationStatus = await reserveUsageBudget(budgetReservation);
      if (reservationStatus === "settled") {
        throw new Error("USAGE_RESERVATION_ALREADY_SETTLED");
      }
    }

    // 微信在「包含全文摘要」模式下会逐篇抓正文（by_article 约 15–30s/篇），
    // 用更宽松的超时预算，避免被通用 60s 一刀切中断。
    const gatherTimeout = claimed.platform === "wechat"
      ? WECHAT_GATHER_TIMEOUT_MS
      : claimed.platform === "x" && claimed.config.provider === "x_grok"
        ? X_GATHER_TIMEOUT_MS
        : GATHER_TIMEOUT_MS;
    await markRunProgress(runId, attemptToken, "gathering");
    const { items, cursor, billableUnits } = await withTimeout(
      (signal) => gather({
        platform: claimed.platform,
        config: claimed.config,
        cursor: claimed.cursor,
      }, { signal, runId, deadline: new Date(Date.now() + gatherTimeout) }),
      gatherTimeout,
      claimed.platform,
      taskSignal,
    );
    // Commit source input first; model processing resumes from durable pending rows.
    const prepared = await prepareIngest(createDrizzleIngestRepository(), {
      items,
      monitorId: claimed.monitorId,
      deferAnalysis: true,
      matchedQuery: monitorMatchedQuery(claimed),
      runId,
      monitorRules: extractMonitorRulesFromConfig(claimed.config as Record<string, unknown>),
      signal: taskSignal,
    });
    // Normalization complete, ready to commit.
    await markRunProgress(runId, attemptToken, "ingesting");

    const monitorUpdate: Partial<typeof monitors.$inferInsert> = {
      lastSuccessAt: new Date(),
      nextRunAt,
      failureCount: 0,
      lastError: null,
      cursor,
      leaseOwner: null,
      leaseUntil: null,
    };
    if (claimed.platform === "wechat" && !isWechatKeywordRuleConfig(claimed.config)) {
      const patch = resolvedWechatConfigPatch(cursor);
      const mpName = usefulWechatName(patch?.mpName);
      if (patch) {
        monitorUpdate.config = {
          ...(claimed.config ?? {}),
          ...patch,
        };
      }
      if (mpName && isAutoWechatName(claimed.name)) {
        monitorUpdate.name = mpName;
      }
    }
    if (claimed.platform === "x") {
      const profileName = typeof cursor.profileName === "string" ? cursor.profileName.trim() : "";
      if (profileName && isAutoXName(claimed.name, claimed.config)) monitorUpdate.name = profileName;
    }

    const result = await db.transaction(async (tx) => {
      // Fenced assertion: verify we still hold the lease before any writes.
      // If another worker took over (epoch changed), this returns 0 rows and
      // the thrown error rolls back the entire transaction.
      const [asserted] = await tx
        .update(monitors)
        .set({ leaseUntil: new Date(Date.now() + getMonitorLeaseMs()) })
        .where(and(
          eq(monitors.id, claimed.id),
          eq(monitors.leaseOwner, getLeaseWorkerId()),
          eq(monitors.leaseEpoch, claimedEpoch),
        ))
        .returning({ id: monitors.id });
      if (!asserted) {
        throw new Error("LEASE_LOST: Monitor lease was taken by another worker");
      }

      const committed = await commitPreparedIngest(createDrizzleIngestRepository(tx), prepared);
      await markRunProgress(runId, attemptToken, "committing", tx);

      // Usage rows share the run's idempotency key. A retried commit can never
      // count the same provider metric twice. Model usage is recorded by analysis.
      if (claimed.platform === "x") {
        const units = billableUnits ?? 1;
        const grokSubscription = claimed.config.provider === "x_grok";
        await recordUsage(
          tx,
          runKey,
          claimed.connectorId,
          claimed.monitorId,
          grokSubscription ? "x_grok_searches" : "x_billable_units",
          units,
          grokSubscription ? 0 : (units / 1000) * X_COST_PER_1K_UNITS,
        );
        await settleUsageReservation(tx, budgetReservationKey, attemptToken);
      } else if (claimed.platform === "web_search") {
        const provider = ((claimed.config as WebSearchMonitorConfig).provider ?? "brave");
        await recordUsage(
          tx,
          runKey,
          claimed.connectorId,
          claimed.monitorId,
          `${provider}_queries`,
          billableUnits ?? 1,
          provider === "brave" ? BRAVE_COST_PER_1K / 1000 : 0,
        );
        await settleUsageReservation(tx, budgetReservationKey, attemptToken);
      }
      const [monitorUpdated] = await tx
        .update(monitors)
        .set(monitorUpdate)
        .where(and(eq(monitors.id, claimed.id), eq(monitors.leaseOwner, getLeaseWorkerId()), eq(monitors.leaseEpoch, claimedEpoch)))
        .returning({ id: monitors.id });
      if (!monitorUpdated) {
        throw new Error("LEASE_LOST: Monitor update affected 0 rows — lease expired mid-commit");
      }

      const [runUpdated] = await tx
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
          providerCost: "0",
        })
        .where(and(eq(collectionRuns.id, runId), eq(collectionRuns.attemptToken, attemptToken)))
        .returning({ id: collectionRuns.id });
      if (!runUpdated) {
        throw new Error("ATTEMPT_TOKEN_MISMATCH: Collection run update affected 0 rows");
      }
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
      nextRunAt,
    });
    recordCollectionSuccess();
    await refreshEventProjection().catch(error => workerLog.warn("events.refresh.failed", { error }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (globalShutdownSignal?.aborted && !isLeaseLossAbort(taskSignal)) {
      await db.transaction(async (tx) => {
        await releaseUsageReservation(tx, budgetReservationKey, attemptToken);
        await tx.update(monitors).set({ leaseOwner: null, leaseUntil: null }).where(and(
          eq(monitors.id, claimed.id),
          eq(monitors.leaseOwner, getLeaseWorkerId()),
          eq(monitors.leaseEpoch, claimedEpoch),
        ));
        await tx.update(collectionRuns).set({
          status: "failed",
          finishedAt: new Date(),
          errorCode: "RUN_INTERRUPTED",
          errorMessage: "Worker stopped before this run finished.",
        }).where(and(eq(collectionRuns.id, runId), eq(collectionRuns.attemptToken, attemptToken)));
      });
      throw globalShutdownSignal.reason instanceof Error
        ? globalShutdownSignal.reason
        : new Error("WORKER_SHUTDOWN");
    }
    const budgetRetryAt = nextBudgetRetryAt(message);
    const failure = classifyMonitorFailure(message);
    const accounting = monitorFailureAccounting({
      currentFailureCount: claimed.failureCount,
      failure,
      plannedPause: Boolean(budgetRetryAt),
    });
    if (accounting.countForWorkerHealth) recordCollectionFailure();
    const failureCount = accounting.failureCount;
    if (budgetRetryAt) {
      nextRunAt = budgetRetryAt;
    } else if (failure.retryAfterMinutes) {
      nextRunAt = nextStaggeredRunAt({ intervalMinutes: failure.retryAfterMinutes, staggerKey });
    }
    const suspensionMinutes = shouldSuspendMonitor(failureCount, MONITOR_DISABLE_AFTER_FAILURES, message);
    // Circuit-break: if the failure threshold is reached, push nextRunAt far
    // enough into the future that the monitor naturally pauses, but don't
    // permanently disable it. Transient upstream issues will self-heal.
    const suspendedNextRunAt = suspensionMinutes > 0
      ? new Date(Date.now() + suspensionMinutes * 60_000)
      : nextRunAt;
    const errorCode = failure.code;
    await db.transaction(async (tx) => {
      await releaseUsageReservation(tx, budgetReservationKey, attemptToken);
      await tx
        .update(monitors)
        .set({
          failureCount,
          lastError: message,
          nextRunAt: suspendedNextRunAt,
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(and(eq(monitors.id, claimed.id), eq(monitors.leaseOwner, getLeaseWorkerId()), eq(monitors.leaseEpoch, claimedEpoch)));

      await tx
        .update(collectionRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorCode,
          errorMessage: message,
        })
        .where(and(eq(collectionRuns.id, runId), eq(collectionRuns.attemptToken, attemptToken)));
    });

    runLog.warn("collection.failed", {
      durationMs: Date.now() - startedAt,
      errorCode,
      errorMessage: message,
      failureCount,
      suspensionMinutes: suspensionMinutes || null,
      suspendThreshold: MONITOR_DISABLE_AFTER_FAILURES || null,
      monitorSuspended: suspensionMinutes > 0,
      transient: isTransientMonitorFailure(message),
      budgetExhausted: isBudgetExhaustion(message),
      nextRunAt,
    });
  }
}

/**
 * Returns minutes to suspend the monitor after repeated failures.
 * At threshold, suspend for 6 hours; each additional failure doubles the
 * suspension up to 24 hours. Returns 0 if the failure doesn't qualify.
 */
export function shouldSuspendMonitor(
  failureCount: number,
  threshold = MONITOR_DISABLE_AFTER_FAILURES,
  message = "",
): number {
  if (threshold <= 0 || failureCount < threshold) return 0;
  if (!classifyMonitorFailure(message).disableEligible) return 0;
  const excessFailures = failureCount - threshold;
  return Math.min(24 * 60, 6 * 60 * Math.pow(2, excessFailures));
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
  "ZLZCHAT_BASE_URL",
  "ZLZCHAT_API_KEY",
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
  const [subscription] = await db.select({ id: monitors.id }).from(monitors).where(and(
    eq(monitors.enabled, true), eq(monitors.platform, "wechat"),
    sql`coalesce(${monitors.config}->>'provider', '') <> 'zlzchat'`,
    sql`coalesce(${monitors.config}->>'kind', '') <> 'keyword_rule'`,
  )).limit(1);
  if (!subscription) return;
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
    if (isWechatKeywordRuleConfig(row.config) || row.config.provider === "zlzchat") return [];
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
    ))
    .orderBy(monitors.nextRunAt)
    .limit(100);

  let claimedCount = 0;
  let activeCount = 0;

  // Provider-level bulkhead: prevent a single slow provider (e.g. WeChat)
  // from consuming all concurrency slots and starving other monitors.
  const providerConcurrency: Record<string, number> = {
    // WeRSS and its browser-backed full-text fallback share one local
    // collection resource. ZLZChat is a separate HTTP service and gets its
    // own bucket.
    "wechat-browser": 1,
    zlzchat: 1,
    // X: API rate limits are tight
    x: 1,
    x_grok: 1,
    x_official: 1,
    // Web search providers
    brave: 2,
    tavily: 2,
    serper: 2,
    // TrendRadar
    trendradar: 2,
    // Default for unrecognized providers
    default: 2,
  };
  const providerActive = new Map<string, number>();

  function providerKey(monitor: typeof due[number]): string {
    // Derive concurrency bucket from platform and provider config.
    // connectorId is a UUID — use platform (e.g. "wechat", "x", "web_search")
    // with provider override from config when available.
    const cfg = monitor.config as Record<string, unknown> | null;
    const provider = typeof cfg?.provider === "string" ? cfg.provider : null;
    // web_search platform has per-provider limits (brave/tavily/serper)
    if (monitor.platform === "web_search" && provider) return provider;
    // All WeRSS account monitors (including its direct full-text fallback)
    // share the browser/resource bucket. ZLZChat is independent.
    if (monitor.platform === "wechat") return provider === "zlzchat" ? "zlzchat" : "wechat-browser";
    // x: distinguish x_grok vs x_official
    if (monitor.platform === "x" && provider) return provider;
    // Fall back to platform name
    return monitor.platform || "default";
  }

  // The due query is ordered by time, but a burst of one provider must not
  // occupy the whole 100-row window and starve every other provider. Pick one
  // task per provider in round-robin order while retaining oldest-first order
  // inside each provider bucket.
  const dueByProvider = new Map<string, Array<typeof due[number]>>();
  for (const monitor of due) {
    const key = providerKey(monitor);
    const bucket = dueByProvider.get(key) ?? [];
    bucket.push(monitor);
    dueByProvider.set(key, bucket);
  }
  const fairDue: Array<typeof due[number]> = [];
  let fairIndex = 0;
  while (true) {
    let added = false;
    for (const bucket of dueByProvider.values()) {
      const monitor = bucket[fairIndex];
      if (!monitor) continue;
      fairDue.push(monitor);
      added = true;
    }
    if (!added) break;
    fairIndex += 1;
  }

  function providerAtCapacity(key: string): boolean {
    const limit = providerConcurrency[key] ?? providerConcurrency["default"] ?? 2;
    return (providerActive.get(key) ?? 0) >= limit;
  }

  for (const monitor of fairDue) {
    if (shutdownSignal?.aborted) break;

    const pKey = providerKey(monitor);

    // Wait for a free concurrency slot before claiming the next monitor.
    while (activeCount >= WORKER_CONCURRENCY) {
      if (shutdownSignal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (shutdownSignal?.aborted) break;

    // Skip if this provider is already at its concurrency limit.
    // The monitor stays unclaimed and will be retried next poll cycle.
    if (providerAtCapacity(pKey)) continue;

    const claimed = await claimMonitor(monitor);
    if (!claimed) continue;
    claimedCount += 1;
    activeCount += 1;
    providerActive.set(pKey, (providerActive.get(pKey) ?? 0) + 1);
    const claimedEpoch = claimed.leaseEpoch;

    // Fire and forget — each monitor runs independently. The counter
    // decrement in .finally() signals a free slot to waiting iterations.
    void (async () => {
    const leaseController = new AbortController();
    const taskSignal = shutdownSignal
      ? AbortSignal.any([shutdownSignal, leaseController.signal])
      : leaseController.signal;
    let leaseRenewalRunning = false;
    const leaseRenewalTimer = setInterval(() => {
      if (leaseRenewalRunning) return;
      leaseRenewalRunning = true;
      retryLeaseRenewal(async () => {
        const rows = await db.update(monitors)
          .set({
            leaseUntil: new Date(Date.now() + getMonitorLeaseMs()),
          })
          .where(and(
            eq(monitors.id, monitor.id),
            eq(monitors.leaseOwner, getLeaseWorkerId()),
            eq(monitors.leaseEpoch, claimedEpoch),
          ))
          .returning({ id: monitors.id });
        return rows.length === 1;
      }, { signal: taskSignal })
        .then((renewed) => {
          if (!renewed) {
            leaseController.abort(new Error("LEASE_LOST"));
            workerLog.error("monitor.lease_renewal.lost", {
              monitorId: claimed.monitorId,
              platform: claimed.platform,
            });
          }
        })
        .catch((error) => {
          if (taskSignal.aborted) return;
          leaseController.abort(new Error("LEASE_RENEWAL_UNCONFIRMED", { cause: error }));
          workerLog.error("monitor.lease_renewal.failed", {
            monitorId: claimed.monitorId,
            platform: claimed.platform,
            error,
          });
        })
        .finally(() => { leaseRenewalRunning = false; });
    }, Math.min(60_000, Math.max(5_000, Math.floor(getMonitorLeaseMs() / 3))));
    try {
      await runMonitor(claimed, claimedEpoch, taskSignal, shutdownSignal);
    } finally {
      clearInterval(leaseRenewalTimer);
      // Release the lease only if we still own it (epoch matches).
      // Adding leaseEpoch prevents a stale worker from releasing a lease
      // that has already been taken by another worker.
      await db.update(monitors).set({ leaseOwner: null, leaseUntil: null }).where(and(
        eq(monitors.id, monitor.id),
        eq(monitors.leaseOwner, getLeaseWorkerId()),
        eq(monitors.leaseEpoch, claimedEpoch),
      ));
    }
    })().catch((error) => {
      workerLog.error("monitor.task.unhandled", {
        monitorId: monitor.id,
        platform: monitor.platform,
        error,
      });
    }).finally(() => {
      activeCount -= 1;
      providerActive.set(pKey, Math.max(0, (providerActive.get(pKey) ?? 1) - 1));
    });
  }

  if (shutdownSignal?.aborted) {
    // Graceful shutdown: wait for running monitors with a hard deadline.
    // If a provider ignores AbortSignal, force-exit after 30s.
    const waitDeadline = Date.now() + 30_000;
    while (activeCount > 0 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (activeCount > 0) {
      workerLog.warn("worker.shutdown.forced", { pendingTasks: activeCount });
    }
  } else {
    // Normal poll: wait for all tasks from this batch to complete.
    // Provider-level bulkhead prevents over-subscription across batches.
    while (activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!shutdownSignal?.aborted && !analysisTask) {
    analysisTask = maybeProcessContentAnalysis(shutdownSignal).then(async () => {
      if (!shutdownSignal?.aborted) await refreshEventProjection().catch(error => workerLog.warn("events.refresh.failed", { error }));
    }).finally(() => { analysisTask = null; });
  }
  if (!shutdownSignal?.aborted) {
    await refreshEventProjection().catch((error) => workerLog.warn("events.refresh.failed", { error }));
    if (Date.now() - lastMaintenanceAt >= 86400000) {
      const pruned = await pruneOperationalHistory().catch(error => workerLog.warn("history.prune.failed", { error }));
      if (pruned && pruned.collectionRuns < HISTORY_PRUNE_BATCH_SIZE && pruned.modelAttempts < HISTORY_PRUNE_BATCH_SIZE) lastMaintenanceAt = Date.now();
    }
  }
  return claimedCount;
}

export async function markWorkerHeartbeat(now = new Date()): Promise<void> {
  const status = deriveWorkerRuntimeStatus({
    consecutivePollFailures,
    pollFailureThreshold: WORKER_DEGRADED_AFTER_POLL_FAILURES,
    consecutiveCollectionFailures,
    collectionFailureThreshold: WORKER_DEGRADED_AFTER_COLLECTION_FAILURES,
    lastCollectionFailureAt,
  });
  const detail = {
    pid: process.pid,
    workerId: getLeaseWorkerId(),
    pollStartedAt: pollStartedAt?.toISOString() ?? null,
    lastPollStartedAt: lastPollStartedAt?.toISOString() ?? null,
    lastPollCompletedAt: lastPollCompletedAt?.toISOString() ?? null,
    lastSuccessfulPollAt: lastSuccessfulPollAt?.toISOString() ?? null,
    lastPollErrorName,
    consecutivePollFailures,
    lastCollectionSuccessAt: lastCollectionSuccessAt?.toISOString() ?? null,
    lastCollectionFailureAt: lastCollectionFailureAt?.toISOString() ?? null,
    consecutiveCollectionFailures,
  };
  await Promise.all([
    writeFile(WORKER_HEARTBEAT_FILE, now.toISOString(), "utf8"),
    db.insert(runtimeHealth).values({
      service: getWorkerHealthService(),
      status,
      lastHeartbeatAt: now,
      detail,
    }).onConflictDoUpdate({
      target: runtimeHealth.service,
      set: { status, lastHeartbeatAt: now, detail },
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

const CONTENT_RETRY_INTERVAL_MS = (Number(process.env.CONTENT_RETRY_INTERVAL_MINUTES) || 15) * 60_000;
const CONTENT_RETRY_BATCH_SIZE = Math.max(1, Number(process.env.CONTENT_RETRY_BATCH_SIZE) || 5);
const CONTENT_RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.CONTENT_RETRY_MAX_ATTEMPTS) || 5);
let lastMaintenanceAt = 0;
let analysisTask: Promise<void> | null = null;

export async function waitForContentAnalysis(): Promise<void> {
  await analysisTask;
}

async function maybeProcessContentAnalysis(signal?: AbortSignal): Promise<void> {
  try {
    // Drain newly deferred work each poll. Failed analyses retain their existing cooldown.
    const result = await backfillMissingSummaries(CONTENT_RETRY_BATCH_SIZE, {
      scope: "automatic",
      retryAfterMinutes: CONTENT_RETRY_INTERVAL_MS / 60_000,
      maxAttempts: CONTENT_RETRY_MAX_ATTEMPTS,
      signal,
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
type DbExecutor = Pick<typeof db, "update">;

async function markRunProgress(
  runId: string,
  attemptToken: string,
  stage: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(collectionRuns)
    .set({ currentStage: stage, lastProgressAt: new Date() })
    .where(and(
      eq(collectionRuns.id, runId),
      eq(collectionRuns.attemptToken, attemptToken),
      eq(collectionRuns.status, "running"),
    ))
    .catch((error) => workerLog.warn("run.progress.update_failed", { runId, attemptToken, stage, error }));
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
    monitorLeaseSeconds: getMonitorLeaseMs() / 1000,
  });
  await markWorkerHeartbeat();
  let heartbeatPromise: Promise<void> | null = null;
  const startHeartbeat = () => {
    if (heartbeatPromise) return;
    heartbeatPromise = markWorkerHeartbeat()
      .catch((error) => workerLog.warn("worker.heartbeat.failed", { error }))
      .finally(() => { heartbeatPromise = null; });
  };
  const heartbeatTimer = setInterval(() => {
    startHeartbeat();
  }, 15_000);
  let staleReaperPromise: Promise<void> | null = null;
  const startStaleReaper = () => {
    if (staleReaperPromise) return;
    staleReaperPromise = cleanupStaleRunningRuns(getMonitorLeaseMs(), workerLog)
      .then((cleaned) => {
        if (cleaned) workerLog.warn("collection.stale_runs.cleaned", { cleaned });
      })
      .catch((error) => workerLog.warn("collection.stale_runs.cleanup_failed", { error }))
      .finally(() => { staleReaperPromise = null; });
  };
  startStaleReaper();
  if (staleReaperPromise) await staleReaperPromise;
  const staleReaperTimer = setInterval(startStaleReaper, staleRunReaperIntervalMs());
  while (!stopped) {
    pollStartedAt = new Date();
    lastPollStartedAt = pollStartedAt;
    try {
      const count = await runOnce(shutdownController.signal);
      const completedAt = new Date();
      lastPollCompletedAt = completedAt;
      lastSuccessfulPollAt = completedAt;
      lastPollErrorName = null;
      consecutivePollFailures = 0;
      workerLog.info("worker.poll.completed", { claimedMonitorCount: count });
    } catch (err) {
      lastPollCompletedAt = new Date();
      lastPollErrorName = err instanceof Error ? err.name : "UnknownError";
      consecutivePollFailures += 1;
      workerLog.error("worker.poll.failed", { error: err });
    }
    pollStartedAt = null;
    await markWorkerHeartbeat()
      .catch((error) => workerLog.warn("worker.heartbeat.failed", { error }));
    // 以 1s 粒度等待，便于收到 SIGTERM 时快速退出。
    const deadline = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < deadline && !stopped) await sleep(1000);
  }
  clearInterval(heartbeatTimer);
  clearInterval(staleReaperTimer);
  await Promise.allSettled([
    waitForContentAnalysis(),
    ...(heartbeatPromise ? [heartbeatPromise] : []),
    ...(staleReaperPromise ? [staleReaperPromise] : []),
  ]);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await postgresClient.end({ timeout: 5 });
  workerLog.info("worker.stopped");
}

// Only run the loop when invoked directly (e.g. `pnpm worker`). When imported
// by unit tests, this must not execute.
if (process.argv[1] && /worker\/index\.(?:ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    workerLog.error("worker.fatal", { error: err });
    process.exit(1);
  });
}
