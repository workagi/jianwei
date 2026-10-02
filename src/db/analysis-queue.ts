import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { items } from "./schema";

/** The automatic worker and its backlog counters share the same work predicate. */
export function automaticAnalysisCondition(maxAttempts: number, retryCutoff: Date) {
  return and(
    or(and(eq(items.analysisStatus, "pending"), or(sql`${items.contentRevision} > 1`, isNotNull(items.analysisVersion))),
      and(eq(items.analysisStatus, "failed"), or(isNull(items.analyzedAt), lt(items.analyzedAt, retryCutoff)))),
    lt(items.analysisAttempts, maxAttempts),
    sql`exists (select 1 from item_matches im where im.item_id = ${items.id} and im.retention_status = 'kept')`,
  )!;
}
