import { db } from "@/db";
import { monitors, collectionRuns, usageLedger } from "@/db/schema";
import { loadApiCredentials } from "@/db/queries";
import { and, eq, lte, gte, sql } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { ingest, createDrizzleIngestRepository } from "@/ingestion/ingest-items";
import { TrendRadarConnector } from "@/connectors/trendradar/trendradar-connector";
import { TrendRadarMcpClient } from "@/connectors/trendradar/mcp-client";
import {
  createXConnector,
  createWebSearchConnector,
  createWeRssConnector,
} from "@/connectors/factory";
import type {
  NormalizedItem,
  PlatformType,
  XMonitorConfig,
  WebSearchMonitorConfig,
  WechatAccountMonitorConfig,
} from "@/connectors/types";
import { isWechatKeywordRuleConfig } from "@/connectors/types";
import { collectWechatKeywordRule } from "@/connectors/wechat/keyword-rule";

const TRENDRADAR_ENDPOINT = process.env.TRENDRADAR_MCP_URL ?? "http://127.0.0.1:3333/mcp";

// Cost per 1000 billable units. Brave's published rate is $3 / 1k queries; X has
// no stable public rate, so it defaults to 0 and can be overridden.
const BRAVE_COST_PER_1K = 3;
const X_COST_PER_1K_UNITS = Number(process.env.X_COST_PER_1K_UNITS ?? "0") || 0;
const MONTHLY_BUDGET_USD = Number(process.env.X_BRAVE_MONTHLY_BUDGET_USD);
const BUDGET_ENABLED = Number.isFinite(MONTHLY_BUDGET_USD) && MONTHLY_BUDGET_USD > 0;
const MONITOR_DISABLE_AFTER_FAILURES = Number(process.env.WORKER_DISABLE_MONITOR_AFTER_FAILURES ?? "5") || 0;
const WORKER_HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/signaldeck-worker-heartbeat";

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

/**
 * Collect normalized items for one monitor. TrendRadar is wired via its MCP
 * sidecar. X / WebSearch / WeChat are wired directly (Task 3 + P2).
 */
export async function gather(input: GatherInput): Promise<GatherOutput> {
  if (input.platform === "trendradar") {
    const connector = new TrendRadarConnector(new TrendRadarMcpClient(TRENDRADAR_ENDPOINT));
    const items = [...(await connector.latestNews(50)), ...(await connector.latestRss(50, 2))];
    return { items, cursor: {} };
  }
  if (input.platform === "x") {
    const result = await createXConnector().collect(input.config as XMonitorConfig, input.cursor);
    return { items: result.items, cursor: result.cursor, billableUnits: result.billableUnits };
  }
  if (input.platform === "web_search") {
    const config = input.config as WebSearchMonitorConfig;
    const result = await createWebSearchConnector(config.provider ?? "brave").collect(config);
    return { items: result.items, cursor: result.cursor, billableUnits: result.billableUnits };
  }
  if (input.platform === "wechat") {
    if (isWechatKeywordRuleConfig(input.config)) {
      const items = await collectWechatKeywordRule(input.config);
      return { items, cursor: { matchedAt: new Date().toISOString() } };
    }
    const result = await createWeRssConnector().collect(input.config as WechatAccountMonitorConfig, input.cursor);
    return { items: result.items, cursor: result.cursor };
  }
  throw new Error(`UNKNOWN_PLATFORM:${input.platform}`);
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

async function runMonitor(monitor: MonitorRow): Promise<void> {
  const [run] = await db
    .insert(collectionRuns)
    .values({ monitorId: monitor.id, status: "running" })
    .returning({ id: collectionRuns.id });
  const runId = run.id;
  const nextRunAt = new Date(Date.now() + monitor.pollIntervalMinutes * 60_000);

  try {
    // Billable platforms are gated by the monthly budget before any call.
    if (monitor.platform === "x" || monitor.platform === "web_search") {
      await checkBudget(monitor.connectorId);
    }

    // 微信在「包含全文摘要」模式下会逐篇抓正文（by_article 约 15–30s/篇），
    // 用更宽松的超时预算，避免被通用 60s 一刀切中断。
    const gatherTimeout =
      monitor.platform === "wechat" ? WECHAT_GATHER_TIMEOUT_MS : GATHER_TIMEOUT_MS;
    const { items, cursor, billableUnits } = await withTimeout(
      gather({
        platform: monitor.platform,
        config: monitor.config,
        cursor: monitor.cursor,
      }),
      gatherTimeout,
      monitor.platform,
    );
    const result = await ingest(createDrizzleIngestRepository(), {
      items,
      monitorId: monitor.id,
    });

    // Record cost/usage for billable platforms (WeChat cost is 0).
    if (monitor.platform === "x") {
      const units = billableUnits ?? 1;
      await recordUsage(monitor.connectorId, monitor.id, "x_billable_units", units, (units / 1000) * X_COST_PER_1K_UNITS);
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

    await db
      .update(monitors)
      .set({ lastSuccessAt: new Date(), nextRunAt, failureCount: 0, lastError: null, cursor })
      .where(eq(monitors.id, monitor.id));

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
      })
      .where(eq(collectionRuns.id, runId));

    const summaryNote =
      result.summary.attempted > 0
        ? ` / summary ${result.summary.succeeded}/${result.summary.attempted} (${result.summary.status})`
        : "";
    console.log(`[worker] ${monitor.id}: +${result.itemsUpserted} items / ${result.matchesInserted} matches${summaryNote}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureCount = monitor.failureCount + 1;
    const shouldDisable = shouldDisableMonitorAfterFailure(failureCount);
    await db
      .update(monitors)
      .set({
        failureCount,
        lastError: message,
        nextRunAt,
        ...(shouldDisable ? { enabled: false } : {}),
      })
      .where(eq(monitors.id, monitor.id));

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
): boolean {
  return threshold > 0 && failureCount >= threshold;
}

// API 凭据键名（与 .env / factory.ts 保持一致）。worker 每轮采集前把它们从
// 数据库刷新进 process.env，使 factory.ts 通过 process.env 读取时拿到最新值，
// 无需重启。DB 中未配置的键保留容器启动时的 env 值（可能来自 .env）。
// API 凭据键名（与 .env / factory.ts 保持一致）。worker 每轮采集前把它们从
// 数据库刷新进 process.env，使 factory.ts 通过 process.env 读取时拿到最新值，
// 无需重启。仅同步已知键，避免误覆盖其他环境变量。
// 模型 API 相关键（沿用 SUMMARY_* 环境变量）由后台「模型 API」写入 DB，这里同步进 process.env，
// 使 summarizer.ts（按 process.env 读取）在保存后立即生效，无需重启。
const CREDENTIAL_KEYS = [
  "X_BEARER_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY",
  "WERSS_ACCESS_KEY",
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

export async function runOnce(): Promise<number> {
  // 每轮开始前刷新凭据，确保界面保存的密钥立即生效。
  await refreshCredentials();

  const due = await db
    .select()
    .from(monitors)
    .where(and(eq(monitors.enabled, true), lte(monitors.nextRunAt, new Date())));

  for (const monitor of due) await runMonitor(monitor);
  return due.length;
}

export async function markWorkerHeartbeat(now = new Date()): Promise<void> {
  await writeFile(WORKER_HEARTBEAT_FILE, now.toISOString(), "utf8");
}

// Poll interval: clamp to a sane minimum so a misconfigured 0 / negative
// value can't turn the loop into a busy-wait.
const rawPoll = Number(process.env.WORKER_POLL_INTERVAL_SECONDS);
const POLL_INTERVAL_MS = (Number.isFinite(rawPoll) && rawPoll > 0 ? rawPoll : 60) * 1000;

// Per-gather hard timeout. A single connector that hangs (slow X API, wedged
// WeRSS/TrendRadar MCP) must not block the whole poll cycle and starve the
// other due monitors.
const GATHER_TIMEOUT_MS = (Number(process.env.WORKER_GATHER_TIMEOUT_SECONDS) || 60) * 1000;
// 微信公众号在「包含全文摘要」模式下会逐篇抓取文章正文（by_article 约 15–30s/篇），
// 需要比通用采集更长的超时预算，否则会被通用 60s 一刀切中断。
const WECHAT_GATHER_TIMEOUT_MS = (Number(process.env.WORKER_WECHAT_GATHER_TIMEOUT_SECONDS) || 180) * 1000;

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`GATHER_TIMEOUT:${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[worker] 启动采集循环，间隔 ${POLL_INTERVAL_MS / 1000}s`);
  await markWorkerHeartbeat();
  try {
    const cleaned = await cleanupStaleRunningRuns();
    if (cleaned) console.warn(`[worker] 已清理 ${cleaned} 条中断的运行记录`);
  } catch (err) {
    console.warn("[worker] 清理中断运行记录失败:", err);
  }
  while (!stopped) {
    try {
      const count = await runOnce();
      await markWorkerHeartbeat();
      console.log(`[worker] 处理 ${count} 个到期监控任务`);
    } catch (err) {
      console.error("[worker] runOnce 异常:", err);
    }
    // 以 1s 粒度等待，便于收到 SIGTERM 时快速退出。
    const deadline = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < deadline && !stopped) await sleep(1000);
  }
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
