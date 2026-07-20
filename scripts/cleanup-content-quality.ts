import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { items } from "@/db/schema";
import { normalizeTopicTags } from "@/lib/item-tags";
import { normalizeSummaryForDisplay } from "@/lib/summarizer";

async function main() {
  const rows = await db
    .select({
      id: items.id,
      aiSummary: items.aiSummary,
      topicTags: items.topicTags,
      retentionReason: items.retentionReason,
      retentionSource: items.retentionSource,
      platform: items.platform,
      title: items.title,
      translatedTitle: items.translatedTitle,
      contentType: items.contentType,
      analysisStatus: items.analysisStatus,
    })
    .from(items);
  let updated = 0;
  let clearedSummaries = 0;
  let clearedRuleReasons = 0;
  let downgradedFalseSuccess = 0;

  for (const row of rows) {
    const topicTags = normalizeTopicTags(row.topicTags);
    const aiSummary = normalizeSummaryForDisplay(row.aiSummary) || null;
    const tagsChanged = JSON.stringify(topicTags) !== JSON.stringify(row.topicTags ?? []);
    const summaryChanged = aiSummary !== (row.aiSummary?.trim() || null);
    const clearRuleReason = row.retentionSource !== "model" && Boolean(row.retentionReason?.trim());
    const foreignTitleNeedsTranslation =
      Boolean(row.title && /[A-Za-z]/.test(row.title) && !/[\u3400-\u9fff]/.test(row.title));
    const missingRequiredTranslation =
      (row.platform === "x" || foreignTitleNeedsTranslation) && !row.translatedTitle?.trim();
    const incompleteSuccess =
      row.analysisStatus === "success" &&
      (
        row.retentionSource !== "model" ||
        !row.retentionReason?.trim() ||
        !row.contentType ||
        topicTags.length === 0 ||
        missingRequiredTranslation
      );
    const nextAnalysisStatus =
      row.aiSummary && !aiSummary
        ? "pending"
        : incompleteSuccess
          ? "partial"
          : undefined;
    if (!tagsChanged && !summaryChanged && !clearRuleReason && !nextAnalysisStatus) continue;

    await db
      .update(items)
      .set({
        topicTags,
        aiSummary,
        ...(clearRuleReason ? { retentionReason: null } : {}),
        ...(nextAnalysisStatus
          ? { analysisStatus: nextAnalysisStatus, analysisErrorCode: null, analysisErrorMessage: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(items.id, row.id));
    updated += 1;
    if (row.aiSummary && !aiSummary) clearedSummaries += 1;
    if (clearRuleReason) clearedRuleReasons += 1;
    if (incompleteSuccess && nextAnalysisStatus === "partial") downgradedFalseSuccess += 1;
  }

  console.log(JSON.stringify({
    scanned: rows.length,
    updated,
    clearedSummaries,
    clearedRuleReasons,
    downgradedFalseSuccess,
  }));
  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
