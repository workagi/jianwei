import type { NormalizedItem } from "@/connectors/types";
import {
  generateSummariesWithStats,
  summaryKey,
  type SummaryAttemptResult,
  type SummaryRunStats,
} from "@/lib/summarizer";
import {
  deriveItemClassification,
  normalizeContentType,
  normalizeTopicTags,
  type ContentTypeId,
} from "@/lib/item-tags";
import { deriveRetentionDecision } from "@/lib/content-retention";

export const CONTENT_ANALYSIS_VERSION = "v2";

export type ContentAnalysisStatus =
  | "pending"
  | "success"
  | "partial"
  | "failed"
  | "skipped"
  | "disabled";

export interface ContentRouteOutcome {
  status: ContentAnalysisStatus;
  summary?: string;
  translatedTitle?: string;
  contentType: ContentTypeId;
  topicTags: string[];
  classificationSource: "model" | "rules";
  retentionReason: string;
  relevanceScore: number;
  retentionSource: "model" | "rules";
  provider?: string;
  model?: string;
  version: string;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  processedAt: Date;
}

export interface ContentRouteBatch {
  outcomes: Map<string, ContentRouteOutcome>;
  stats: SummaryRunStats;
}

function attempted(status: SummaryAttemptResult["status"]): number {
  return status === "success" || status === "failed" || status === "rate_limited" || status === "timeout" ? 1 : 0;
}

function needsChineseDisplayTitle(item: NormalizedItem): boolean {
  if (item.platform === "x") return true;
  const title = item.title?.trim() ?? "";
  return /[A-Za-z]/.test(title) && !/[\u3400-\u9fff]/.test(title);
}

/**
 * Convert one provider attempt into the durable product-facing state.
 * Classification rules are deliberately only a fallback; they never turn a
 * failed model call into a false model success.
 */
export function buildContentRouteOutcome(
  item: NormalizedItem,
  attempt: SummaryAttemptResult,
  processedAt = new Date(),
): ContentRouteOutcome {
  const fallback = deriveItemClassification({
    platform: item.platform,
    authorName: item.authorName ?? null,
    authorHandle: item.authorHandle ?? null,
    title: item.title ?? null,
    bodyText: item.text,
    aiSummary: attempt.summary ?? null,
  });
  const modelType = normalizeContentType(attempt.contentType);
  const modelTags = normalizeTopicTags(attempt.topicTags);
  const completeModelClassification = Boolean(modelType) && modelTags.length > 0;
  const contentType = modelType ?? fallback.contentType;
  const topicTags = modelTags.length ? modelTags : fallback.topicTags;
  const retention = deriveRetentionDecision({
    item,
    contentType,
    topicTags,
    summary: attempt.summary,
    modelReason: attempt.retentionReason,
    modelScore: attempt.relevanceScore,
  });
  const completeModelRetention = retention.source === "model";
  const completeDisplayTitle = !needsChineseDisplayTitle(item) || Boolean(attempt.translatedTitle?.trim());

  let status: ContentAnalysisStatus;
  if (attempt.status === "success" && attempt.summary) {
    status = completeModelClassification && completeModelRetention && completeDisplayTitle ? "success" : "partial";
  } else if (attempt.status === "disabled") {
    status = "disabled";
  } else if (attempt.status === "skipped") {
    status = "skipped";
  } else {
    status = "failed";
  }

  return {
    status,
    summary: attempt.summary,
    translatedTitle: attempt.translatedTitle,
    contentType,
    topicTags,
    classificationSource: completeModelClassification ? "model" : "rules",
    // Rule-derived labels/scores remain useful internally, but a generic
    // category sentence is not a reader-facing recommendation reason.
    retentionReason: retention.source === "model" ? retention.reason : "",
    relevanceScore: retention.relevanceScore,
    retentionSource: retention.source,
    provider: attempt.provider,
    model: attempt.model,
    version: CONTENT_ANALYSIS_VERSION,
    attempts: attempted(attempt.status),
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    processedAt,
  };
}

/** Route a batch through the configured model once and return an outcome for every item. */
export async function routeContentItems(items: NormalizedItem[]): Promise<ContentRouteBatch> {
  const { attempts, stats } = await generateSummariesWithStats(items);
  const outcomes = new Map<string, ContentRouteOutcome>();
  for (const item of items) {
    const attempt = attempts.get(summaryKey(item)) ?? { status: "skipped" as const };
    outcomes.set(summaryKey(item), buildContentRouteOutcome(item, attempt));
  }
  return { outcomes, stats };
}
