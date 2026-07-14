import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { itemMatches, items } from "@/db/schema";
import type { ConnectorPreview, NormalizedItem, WechatKeywordMonitorConfig } from "@/connectors/types";
import { wechatKeywordMonitorSchema } from "@/connectors/types";

type WechatItemRow = typeof items.$inferSelect;

function stripHtml(value: string | null | undefined): string {
  return (value ?? "").replace(/<[^>]+>/g, " ");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function termsFor(config: WechatKeywordMonitorConfig): string[] {
  return (config.requiredTerms.length ? config.requiredTerms : [config.query])
    .map(normalize)
    .filter(Boolean);
}

function searchableText(row: WechatItemRow, config: WechatKeywordMonitorConfig): string {
  const parts: string[] = [];
  if (config.fields.includes("title")) parts.push(row.title ?? "");
  if (config.fields.includes("summary")) parts.push(row.bodyText ?? "", row.aiSummary ?? "");
  if (config.fields.includes("content")) parts.push(stripHtml(row.contentHtml));
  return normalize(parts.join(" "));
}

export function matchesWechatKeywordRule(row: WechatItemRow, config: WechatKeywordMonitorConfig): boolean {
  const text = searchableText(row, config);
  if (!text) return false;

  const excluded = config.excludedTerms.map(normalize).filter(Boolean);
  if (excluded.some((term) => text.includes(term))) return false;

  const terms = termsFor(config);
  if (terms.length === 0) return false;
  if (config.matchMode === "all") return terms.every((term) => text.includes(term));
  return terms.some((term) => text.includes(term));
}

function toNormalized(row: WechatItemRow): NormalizedItem {
  return {
    platform: "wechat",
    upstreamId: row.upstreamId,
    canonicalUrl: row.canonicalUrl,
    authorId: row.authorId ?? undefined,
    authorName: row.authorName ?? undefined,
    authorHandle: row.authorHandle ?? undefined,
    title: row.title ?? undefined,
    text: row.bodyText,
    contentHtml: row.contentHtml ?? undefined,
    imageUrls: row.imageUrls ?? [],
    publishedAt: row.publishedAt,
    raw: { keywordRuleMatch: true },
  };
}

export async function collectWechatKeywordRule(
  rawConfig: unknown,
  limit = 80,
): Promise<NormalizedItem[]> {
  const config = wechatKeywordMonitorSchema.parse(rawConfig);
  const conditions = [eq(items.platform, "wechat")];
  if (config.sourceMonitorIds.length > 0) {
    conditions.push(sql`exists (
      select 1
      from ${itemMatches}
      where ${itemMatches.itemId} = ${items.id}
        and ${inArray(itemMatches.monitorId, config.sourceMonitorIds)}
    )`);
  }

  const rows = await db
    .select()
    .from(items)
    .where(sql.join(conditions, sql` and `))
    .orderBy(desc(items.publishedAt))
    .limit(500);

  return rows
    .filter((row) => matchesWechatKeywordRule(row, config))
    .slice(0, limit)
    .map(toNormalized);
}

export async function previewWechatKeywordRule(rawConfig: unknown): Promise<ConnectorPreview> {
  const config = wechatKeywordMonitorSchema.parse(rawConfig);
  const matched = await collectWechatKeywordRule(config, 10);
  return {
    displayName: `${config.query} · 公众号关键词`,
    items: matched,
    warning: matched.length
      ? undefined
      : "当前已订阅公众号文章库里暂未命中；保存后会继续随公众号新文章自动匹配。",
  };
}
