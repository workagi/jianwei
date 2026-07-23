import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { monitors } from "@/db/schema";

type MonitorRow = typeof monitors.$inferSelect;
import { createStructuredLogger } from "@/lib/structured-log";

const WORKER_ID =
  process.env.WORKER_ID?.trim() ||
  `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const MONITOR_LEASE_MS =
  (Number(process.env.WORKER_MONITOR_LEASE_SECONDS) || 1800) * 1000;

const leaseLog = createStructuredLogger({
  service: "worker",
  workerId: WORKER_ID,
});

export type ClaimedMonitor = {
  id: string;
  monitorId: string;
  leaseEpoch: number;
  platform: MonitorRow["platform"];
  connectorId: string;
  name: string;
  config: Record<string, unknown>;
  pollIntervalMinutes: number;
  nextRunAt: Date;
  cursor: Record<string, unknown>;
  failureCount: number;
  lastError: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastSuccessAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
};

/**
 * Atomically claim a due monitor. Uses UPDATE … RETURNING with a WHERE
 * clause that filters on lease expiry, so two workers can never claim the
 * same monitor. Returns null if the claim was lost to another worker.
 */
export async function claimMonitor(
  monitor: MonitorRow,
  now = new Date(),
): Promise<ClaimedMonitor | null> {
  const [claimed] = await db
    .update(monitors)
    .set({
      leaseOwner: WORKER_ID,
      leaseUntil: new Date(now.getTime() + MONITOR_LEASE_MS),
      leaseEpoch: sql`${monitors.leaseEpoch} + 1`,
    })
    .where(
      and(
        eq(monitors.id, monitor.id),
        eq(monitors.enabled, true),
        lte(monitors.nextRunAt, now),
        or(isNull(monitors.leaseUntil), lte(monitors.leaseUntil, now)),
      ),
    )
    .returning({
      id: monitors.id,
      leaseEpoch: monitors.leaseEpoch,
      platform: monitors.platform,
      connectorId: monitors.connectorId,
      name: monitors.name,
      config: monitors.config,
      pollIntervalMinutes: monitors.pollIntervalMinutes,
      nextRunAt: monitors.nextRunAt,
      cursor: monitors.cursor,
      failureCount: monitors.failureCount,
      lastError: monitors.lastError,
      enabled: monitors.enabled,
      createdAt: monitors.createdAt,
      updatedAt: monitors.updatedAt,
      lastSuccessAt: monitors.lastSuccessAt,
      leaseOwner: monitors.leaseOwner,
      leaseUntil: monitors.leaseUntil,
    });

  if (!claimed) {
    leaseLog.warn("monitor.claim.lost", {
      monitorId: monitor.id,
      platform: monitor.platform,
      nextRunAt: monitor.nextRunAt,
    });
    return null;
  }

  return {
    id: claimed.id,
    monitorId: claimed.id,
    leaseEpoch: claimed.leaseEpoch,
    platform: claimed.platform,
    connectorId: claimed.connectorId,
    name: claimed.name,
    config: claimed.config as Record<string, unknown>,
    pollIntervalMinutes: claimed.pollIntervalMinutes,
    nextRunAt: claimed.nextRunAt,
    cursor: claimed.cursor as Record<string, unknown>,
    failureCount: claimed.failureCount,
    lastError: claimed.lastError,
    enabled: claimed.enabled,
    createdAt: claimed.createdAt,
    updatedAt: claimed.updatedAt,
    lastSuccessAt: claimed.lastSuccessAt,
    leaseOwner: claimed.leaseOwner,
    leaseUntil: claimed.leaseUntil,
  };
}

export function getLeaseWorkerId(): string {
  return WORKER_ID;
}

export function getMonitorLeaseMs(): number {
  return MONITOR_LEASE_MS;
}
