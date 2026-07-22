import { and, desc, eq, sql } from "drizzle-orm";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import { isWithinFullTextCooldown, wechatFullTextRetryHours } from "@/connectors/wechat/full-text-resolver";
import { db } from "@/db";
import { itemMatches, items, sourceItems } from "@/db/schema";

export interface WechatContentBackfillResult {
  candidates: number;
  succeeded: number;
  failed: number;
  skippedCooldown: number;
  providers: Record<string, number>;
}

export function clampWechatBackfillLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(20, Math.floor(parsed));
}

export async function backfillWechatFullText(rawLimit: unknown): Promise<WechatContentBackfillResult> {
  const limit = clampWechatBackfillLimit(rawLimit);
  const cooldownHours = wechatFullTextRetryHours();
  // Over-fetch a bit so cooldown skips do not starve the requested batch.
  const scanLimit = Math.min(100, Math.max(limit * 4, limit));
  const rows = await db
    .select({
      id: items.id,
      canonicalUrl: items.canonicalUrl,
      contentFetchStatus: items.contentFetchStatus,
      contentFetchedAt: items.contentFetchedAt,
    })
    .from(items)
    .where(
      and(
        sql`exists (
          select 1 from ${sourceItems}
          where ${sourceItems.itemId} = ${items.id}
            and ${sourceItems.platform} = 'wechat'
        )`,
        sql`(${items.contentHtml} is null or btrim(${items.contentHtml}) = '')`,
        sql`exists (select 1 from ${itemMatches} where ${itemMatches.itemId} = ${items.id})`,
      ),
    )
    .orderBy(desc(items.publishedAt))
    .limit(scanLimit);

  let skippedCooldown = 0;
  const eligible = rows.filter((row) => {
    if (isWithinFullTextCooldown(row.contentFetchStatus, row.contentFetchedAt, cooldownHours)) {
      skippedCooldown += 1;
      return false;
    }
    return Boolean(row.canonicalUrl);
  }).slice(0, limit);

  if (!eligible.length) {
    return { candidates: 0, succeeded: 0, failed: 0, skippedCooldown, providers: {} };
  }

  const connector = await createRuntimeWeRssConnector();
  const providers: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;

  // Serial only: full-text resolver already locks WeRSS browser path; keep
  // backfill single-flight so direct/fallback work also stays gentle.
  for (const row of eligible) {
    const result = await connector.fetchFullTextResult(row.canonicalUrl);
    if (result.html) {
      succeeded += 1;
      const provider = result.provider ?? "unknown";
      providers[provider] = (providers[provider] ?? 0) + 1;
    } else {
      failed += 1;
    }
    await db
      .update(items)
      .set({
        ...(result.html ? { contentHtml: result.html, contentProvider: result.provider } : {}),
        contentFetchStatus: result.status,
        contentFetchError: result.errorCode ?? null,
        contentFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(items.id, row.id));
  }

  return { candidates: eligible.length, succeeded, failed, skippedCooldown, providers };
}
