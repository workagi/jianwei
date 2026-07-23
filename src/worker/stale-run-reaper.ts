import { and, eq, lte, sql } from "drizzle-orm";
import { collectionRuns, monitors } from "@/db/schema";
import { db } from "@/db";
import { type StructuredLogger } from "@/lib/structured-log";

const RUN_PROGRESS_STALE_MS = 10 * 60 * 1000;

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

  const result = await db
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
        eq(collectionRuns.status, "running"),
        lte(collectionRuns.lastProgressAt, progressCutoff),
        sql`exists (
          select 1 from ${monitors}
          where ${monitors.id} = ${collectionRuns.monitorId}
            and (
              ${monitors.leaseUntil} is null
              or ${monitors.leaseUntil} < ${leaseCutoff.toISOString()}
            )
        )`,
      ),
    )
    .returning({ id: collectionRuns.id });

  const cleaned = result.length;
  if (cleaned) {
    log.warn("collection.stale_runs.cleaned", { cleaned });
  }
  return cleaned;
}
