import { db } from "@/db";
import { sql } from "drizzle-orm";

export const HISTORY_PRUNE_BATCH_SIZE = 1000;

/** Operational history only. Source evidence, receipts and budget ledgers remain durable. */
export async function pruneOperationalHistory(now = new Date()) {
  const configuredDays = Number(process.env.OPERATIONAL_HISTORY_DAYS ?? "30");
  if (!(configuredDays > 0)) return { collectionRuns: 0, modelAttempts: 0 };
  // Model attempts participate in today's shared quota: always retain at least 24 hours.
  const days = Math.max(1, Math.floor(configuredDays));
  const failedDays = Math.max(days, Number(process.env.FAILED_HISTORY_DAYS) || 90);
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const failedCutoff = new Date(now.getTime() - failedDays * 86400000).toISOString();
  const [runs] = await db.execute<{ count: number }>(sql`with batch as (
    select id from collection_runs where status <> 'running' and finished_at is not null
      and started_at < ${cutoff}::timestamptz
      and (status <> 'failed' or started_at < ${failedCutoff}::timestamptz)
      order by started_at limit ${HISTORY_PRUNE_BATCH_SIZE} for update skip locked
  ), deleted as (
    delete from collection_runs using batch where collection_runs.id = batch.id returning 1
  ) select count(*)::int as count from deleted`);
  const [attempts] = await db.execute<{ count: number }>(sql`with batch as (
    select id from model_attempts where finished_at is not null
      and started_at < ${cutoff}::timestamptz
      and (status = 'received' or started_at < ${failedCutoff}::timestamptz)
      order by started_at limit ${HISTORY_PRUNE_BATCH_SIZE} for update skip locked
  ), deleted as (
    delete from model_attempts using batch where model_attempts.id = batch.id returning 1
  ) select count(*)::int as count from deleted`);
  return { collectionRuns: runs.count, modelAttempts: attempts.count };
}
