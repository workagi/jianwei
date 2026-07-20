import type { NormalizedItem } from "@/connectors/types";
import { getContentTypeLabel, type ContentTypeId } from "@/lib/item-tags";

export interface RetentionDecision {
  reason: string;
  relevanceScore: number;
  source: "model" | "rules";
}

export function normalizeRelevanceScore(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function normalizeRetentionReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/^(?:保留理由|推荐理由|理由)[：:\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 6 || cleaned.length > 80) return undefined;
  if (/我现在需要处理|用户的请求|keep_reason|relevance_score|值得一读|值得阅读|内容丰富|很有价值/i.test(cleaned)) return undefined;
  // Early rule-based migrations wrote category placeholders into the same
  // column as model-authored reasons. They describe the label, not the
  // concrete information gain, and must never be presented as recommendations.
  if (/^包含(?:有)?(?:[^，。]{1,30}相关的|可核对的|可复用的|明确主题的)?(?:产品动态|模型发布|行业商业|论文研究|实践教程|政策安全|观点解读)(?:信息)?[。.]?$/i.test(cleaned)) return undefined;
  if (/^来自已配置监控任务的可核对信息[。.]?$/i.test(cleaned)) return undefined;
  if (/明确主题.{0,8}关键解读|包括(?:可)?核对的(?:产品动态|模型发布|行业商业|论文研究|实践教程|政策安全|观点解读)/i.test(cleaned)) return undefined;
  return cleaned;
}

const RETENTION_TAG_STOP_WORDS = new Set([
  "ai",
  "人工智能",
  "url",
  "http",
  "https",
  "with",
  "by",
  "who",
  "相关内容",
]);

function reasonTag(value: string): string | undefined {
  const cleaned = value.replace(/^有(?=[A-Z])/, "").trim();
  if (cleaned.length < 2 || cleaned.length > 24) return undefined;
  if (RETENTION_TAG_STOP_WORDS.has(cleaned.toLocaleLowerCase())) return undefined;
  return cleaned;
}

function fallbackReason(contentType: ContentTypeId, topicTags: string[]): string {
  const label = getContentTypeLabel(contentType) ?? "内容动态";
  const topics = topicTags.map(reasonTag).filter((tag): tag is string => Boolean(tag)).slice(0, 2).join("、");
  if (topics) return `包含${topics}相关的${label}信息`;
  return `包含可核对的${label}信息`;
}

function fallbackScore(item: NormalizedItem, contentType: ContentTypeId, topicTags: string[], summary?: string): number {
  let score = 45;
  if (summary && summary.trim().length >= 24) score += 12;
  score += Math.min(16, topicTags.length * 4);
  if (contentType !== "opinion") score += 5;
  if ((item.contentHtml?.length ?? item.text.length) >= 180) score += 6;
  if (item.title?.trim()) score += 3;
  return Math.min(88, score);
}

export function deriveRetentionDecision(input: {
  item: NormalizedItem;
  contentType: ContentTypeId;
  topicTags: string[];
  summary?: string;
  modelReason?: unknown;
  modelScore?: unknown;
}): RetentionDecision {
  const modelReason = normalizeRetentionReason(input.modelReason);
  const modelScore = normalizeRelevanceScore(input.modelScore);
  if (modelReason && modelScore !== undefined) {
    return { reason: modelReason, relevanceScore: modelScore, source: "model" };
  }
  return {
    reason: fallbackReason(input.contentType, input.topicTags),
    relevanceScore: fallbackScore(input.item, input.contentType, input.topicTags, input.summary),
    source: "rules",
  };
}
