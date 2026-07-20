/**
 * One-shot: delete TrendRadar rows the reader would hide.
 * Uses the same gate as ingest + homepage (passesTrendRadarReaderGate).
 *
 * Usage:
 *   DRY_RUN=1 pnpm exec tsx scripts/delete-hidden-trendradar.ts
 *   pnpm exec tsx scripts/delete-hidden-trendradar.ts
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { items } from "@/db/schema";
import { passesTrendRadarReaderGate } from "@/lib/trendradar-interest-filter";

const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");

async function main() {
  const rows = await db
    .select({
      id: items.id,
      platform: items.platform,
      authorName: items.authorName,
      title: items.title,
      bodyText: items.bodyText,
    })
    .from(items);

  const toDelete = rows.filter((row) => {
    if (row.platform !== "trendradar") return false;
    return !passesTrendRadarReaderGate({
      title: row.title,
      text: row.bodyText,
      authorName: row.authorName,
    });
  });

  const bySource = new Map<string, number>();
  for (const row of toDelete) {
    const key = row.authorName?.trim() || "(null)";
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }

  const trendradarTotal = rows.filter((r) => r.platform === "trendradar").length;
  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        totalItems: rows.length,
        trendradarTotal,
        toDelete: toDelete.length,
        keep: rows.length - toDelete.length,
        keepTrendradar: trendradarTotal - toDelete.length,
        bySource: Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])),
      },
      null,
      2,
    ),
  );

  if (toDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  if (DRY_RUN) {
    console.log("Dry run only — re-run without DRY_RUN=1 to delete.");
    return;
  }

  const ids = toDelete.map((row) => row.id);
  const chunkSize = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    // item_matches / bookmarks cascade via FK ON DELETE CASCADE
    const result = await db.delete(items).where(inArray(items.id, chunk)).returning({ id: items.id });
    deleted += result.length;
    console.log(`deleted chunk ${i / chunkSize + 1}: ${result.length} (running total ${deleted})`);
  }

  const [{ count: remainingTr }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(sql`${items.platform} = 'trendradar'`);
  const [{ count: remainingAll }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items);

  console.log(JSON.stringify({ deleted, remainingTrendradar: remainingTr, remainingAll }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
