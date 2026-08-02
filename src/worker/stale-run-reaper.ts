import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { collectionRuns, monitors } from "@/db/schema";
import { db } from "@/db";
import { type StructuredLogger } from "@/lib/structured-log";

const RUN_PROGRESS_STALE_MS = 10 * 60 * 1000;
export const STALE_RUN_REAPER_LOCK_KEY = "jianwei:stale-run-reaper:v1";

/** Keep runtime cleanup frequent, but never turn bad configuration into busy polling. */
export function staleRunReaperIntervalMs(
  raw = process.env.WORKER_STALE_RUN_REAPER_INTERVAL_SECONDS,
): number {
  const seconds = Number(raw);
  const configured = Number.isFinite(seconds) && seconds > 0 ? seconds : 180;
  return Math.min(300, Math.max(60, configured)) * 1000;
}

/**
 * Mark collection runs as failed when the monitor lease has expired or was
 * released (NULL). Runs with a valid lease from any worker are left alone.
 */
export async function cleanupStaleRunningRuns(
  monitorLeaseMs: number,
  log: StructuredLogger,
): Promise<number> {
  const progressCutoff = new Date(Date.now() - RUN_PROGRESS_STALE_MS);
  const leaseCutoff = new Date(Date.now() - monitorLeaseMs - 60_000);
  const cleaned = await db.transaction(async (tx) => {
    const [lock] = await tx.execute(sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(
        hashtextextended(${STALE_RUN_REAPER_LOCK_KEY}, 0)
      ) as locked
    `);
    if (!lock?.locked) return 0;

    // Lock both the stale run and its monitor before changing status. A
    // concurrent monitor claim must wait for this transaction, so a newly
    // acquired valid lease cannot be mistaken for an abandoned execution.
    const candidates = await tx.execute(sql<{ id: string }>`
      select ${collectionRuns.id} as id
      from ${collectionRuns}
      inner join ${monitors}
        on ${monitors.id} = ${collectionRuns.monitorId}
      where ${collectionRuns.status} = 'running'
        and ${collectionRuns.lastProgressAt} <= ${progressCutoff.toISOString()}::timestamptz
        and (
          ${monitors.leaseUntil} is null
          or ${monitors.leaseUntil} < ${leaseCutoff.toISOString()}::timestamptz
        )
      for update of ${collectionRuns}, ${monitors} skip locked
    `);
    const candidateIds = candidates.map((row) => (row as { id: string }).id);
    if (candidateIds.length === 0) return 0;

    // Re-check both stale progress and lease validity in the update itself.
    // This is deliberately redundant with the locked candidate query: it
    // documents and enforces the safety condition at the mutation boundary.
    const result = await tx
      .update(collectionRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorCode: "RUN_INTERRUPTED",
        errorMessage:
          "Abandoned: no progress for 10+ min and monitor lease expired.",
      })
      .where(
        and(
          inArray(collectionRuns.id, candidateIds),
          eq(collectionRuns.status, "running"),
          lte(collectionRuns.lastProgressAt, progressCutoff),
          sql`exists (
            select 1 from ${monitors}
            where ${monitors.id} = ${collectionRuns.monitorId}
              and (
                ${monitors.leaseUntil} is null
                or ${monitors.leaseUntil} < ${leaseCutoff.toISOString()}::timestamptz
              )
          )`,
        ),
      )
      .returning({ id: collectionRuns.id });
    return result.length;
  });

  if (cleaned) {
    log.warn("collection.stale_runs.cleaned", { cleaned });
  }
  return cleaned;
}
