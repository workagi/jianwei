import type { PlatformType } from "@/connectors/types";
import { getContentPipelineStats } from "@/db/queries";

export interface PipelinePlatformAggregate {
  platform: PlatformType;
  total: number;
  withSummary: number;
  structured: number;
  analysisReady?: number;
  analysisFailed?: number;
  explained?: number;
  withFullText: number;
  fallbackFullText?: number;
  fullTextFailed?: number;
}

export interface PipelineRecentAggregate {
  runs24h: number;
  failedRuns24h: number;
  partialRuns24h: number;
  summaryAttempted24h: number;
  summarySucceeded24h: number;
  summaryFailed24h: number;
  modelEstimatedCost24h?: number;
  newItems24h: number;
  lastRunAt: Date | null;
}

export interface PipelineAttentionItem {
  tone: "ok" | "info" | "warning" | "danger";
  text: string;
}

export interface PipelinePlatformView {
  id: PlatformType;
  label: string;
  total: number;
  withSummary: number;
  structured: number;
  analysisReady: number;
  analysisFailed: number;
  analysisPending: number;
  explained: number;
  withFullText: number;
  fallbackFullText: number;
  fullTextFailed: number;
  summaryPercent: number;
  structuredPercent: number;
  analysisPercent: number;
  explainedPercent: number;
}

export interface ContentPipelineView {
  available: boolean;
  total: number;
  withSummary: number;
  structured: number;
  analysisReady: number;
  analysisFailed: number;
  analysisPending: number;
  explained: number;
  summaryMissing: number;
  structuredMissing: number;
  summaryPercent: number;
  structuredPercent: number;
  analysisPercent: number;
  explainedPercent: number;
  wechatTotal: number;
  wechatWithFullText: number;
  wechatMissingFullText: number;
  wechatFullTextPercent: number;
  wechatFallbackFullText: number;
  wechatFullTextFailed: number;
  recent: PipelineRecentAggregate;
  platforms: PipelinePlatformView[];
  attention: PipelineAttentionItem[];
}

const PLATFORM_META: Array<{ id: PlatformType; label: string }> = [
  { id: "x", label: "X / Twitter" },
  { id: "wechat", label: "微信公众号" },
  { id: "web_search", label: "全网搜索" },
  { id: "trendradar", label: "榜单 / RSS" },
];

const emptyRecent = (): PipelineRecentAggregate => ({
  runs24h: 0,
  failedRuns24h: 0,
  partialRuns24h: 0,
  summaryAttempted24h: 0,
  summarySucceeded24h: 0,
  summaryFailed24h: 0,
  newItems24h: 0,
  modelEstimatedCost24h: 0,
  lastRunAt: null,
});

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildContentPipelineView(
  rawPlatforms: PipelinePlatformAggregate[],
  rawRecent: PipelineRecentAggregate,
  available = true,
): ContentPipelineView {
  const byPlatform = new Map(rawPlatforms.map((row) => [row.platform, row]));
  const platforms = PLATFORM_META.map(({ id, label }) => {
    const raw = byPlatform.get(id);
    const total = count(raw?.total);
    const withSummary = Math.min(total, count(raw?.withSummary));
    const structured = Math.min(total, count(raw?.structured));
    const analysisReady = Math.min(total, count(raw?.analysisReady ?? raw?.withSummary));
    const analysisFailed = Math.min(total - analysisReady, count(raw?.analysisFailed));
    const analysisPending = Math.max(0, total - analysisReady - analysisFailed);
    const explained = Math.min(total, count(raw?.explained ?? raw?.structured));
    const withFullText = Math.min(total, count(raw?.withFullText));
    const fallbackFullText = Math.min(withFullText, count(raw?.fallbackFullText));
    const fullTextFailed = Math.min(total, count(raw?.fullTextFailed));
    return {
      id,
      label,
      total,
      withSummary,
      structured,
      analysisReady,
      analysisFailed,
      analysisPending,
      explained,
      withFullText,
      fallbackFullText,
      fullTextFailed,
      summaryPercent: percent(withSummary, total),
      structuredPercent: percent(structured, total),
      analysisPercent: percent(analysisReady, total),
      explainedPercent: percent(explained, total),
    };
  });

  const total = platforms.reduce((sum, row) => sum + row.total, 0);
  const withSummary = platforms.reduce((sum, row) => sum + row.withSummary, 0);
  const structured = platforms.reduce((sum, row) => sum + row.structured, 0);
  const analysisReady = platforms.reduce((sum, row) => sum + row.analysisReady, 0);
  const analysisFailed = platforms.reduce((sum, row) => sum + row.analysisFailed, 0);
  const analysisPending = platforms.reduce((sum, row) => sum + row.analysisPending, 0);
  const explained = platforms.reduce((sum, row) => sum + row.explained, 0);
  const wechat = platforms.find((row) => row.id === "wechat")!;
  const recent: PipelineRecentAggregate = {
    ...emptyRecent(),
    ...rawRecent,
    runs24h: count(rawRecent.runs24h),
    failedRuns24h: count(rawRecent.failedRuns24h),
    partialRuns24h: count(rawRecent.partialRuns24h),
    summaryAttempted24h: count(rawRecent.summaryAttempted24h),
    summarySucceeded24h: count(rawRecent.summarySucceeded24h),
    summaryFailed24h: count(rawRecent.summaryFailed24h),
    modelEstimatedCost24h: money(rawRecent.modelEstimatedCost24h),
    newItems24h: count(rawRecent.newItems24h),
    lastRunAt: dateOrNull(rawRecent.lastRunAt),
  };
  const attention: PipelineAttentionItem[] = [];

  if (!available) {
    attention.push({ tone: "warning", text: "数据库暂时不可用，当前无法统计内容处理状态。" });
  } else if (total === 0) {
    attention.push({ tone: "info", text: "还没有内容入库。先在“监控任务”添加来源，系统采集后这里会显示处理进度。" });
  } else {
    if (recent.failedRuns24h > 0) {
      attention.push({ tone: "danger", text: `过去 24 小时有 ${recent.failedRuns24h} 次采集失败，请到“监控任务”查看具体来源。` });
    }
    if (wechat.total - wechat.withFullText > 0) {
      attention.push({ tone: "warning", text: `${wechat.total - wechat.withFullText} 篇公众号文章还没有抓到全文，模型只能使用标题或片段。` });
    }
    if (total - withSummary > 0) {
      attention.push({ tone: "info", text: `${total - withSummary} 条内容还没有模型摘要，可在下方“模型 API”里小批量补跑。` });
    }
    if (recent.summaryFailed24h > 0) {
      attention.push({ tone: "warning", text: `过去 24 小时有 ${recent.summaryFailed24h} 次摘要处理失败，系统后续采集时仍会继续处理新内容。` });
    }
    if (analysisFailed > 0) {
      attention.push({ tone: "warning", text: `${analysisFailed} 条内容的模型理解失败，可在“模型 API”中小批量重试。` });
    } else if (analysisPending > 0) {
      attention.push({ tone: "info", text: `${analysisPending} 条内容还未完成统一模型理解，其中可能包含模型未启用或公众号缺少全文的内容。` });
    }
    if (total - explained > 0) {
      attention.push({ tone: "info", text: `${total - explained} 条内容还没有推荐理由和相关性分，可通过模型补跑完善。` });
    }
    if (attention.length === 0 && total === structured) {
      attention.push({ tone: "ok", text: "当前处理链路没有明显积压，摘要、分类和标签状态正常。" });
    } else if (attention.length === 0 && total - structured > 0) {
      attention.push({ tone: "info", text: `${total - structured} 条内容还没有完整的分类和标签，可使用模型补跑旧内容。` });
    }
  }

  return {
    available,
    total,
    withSummary,
    structured,
    analysisReady,
    analysisFailed,
    analysisPending,
    explained,
    summaryMissing: Math.max(0, total - withSummary),
    structuredMissing: Math.max(0, total - structured),
    summaryPercent: percent(withSummary, total),
    structuredPercent: percent(structured, total),
    analysisPercent: percent(analysisReady, total),
    explainedPercent: percent(explained, total),
    wechatTotal: wechat.total,
    wechatWithFullText: wechat.withFullText,
    wechatMissingFullText: Math.max(0, wechat.total - wechat.withFullText),
    wechatFullTextPercent: percent(wechat.withFullText, wechat.total),
    wechatFallbackFullText: wechat.fallbackFullText,
    wechatFullTextFailed: wechat.fullTextFailed,
    recent,
    platforms,
    attention,
  };
}

export async function loadContentPipelineView(): Promise<ContentPipelineView> {
  if (!process.env.DATABASE_URL) {
    return buildContentPipelineView([], emptyRecent(), false);
  }
  try {
    const stats = await getContentPipelineStats();
    return buildContentPipelineView(
      stats.platforms.map((row) => ({
        platform: row.platform,
        total: Number(row.total ?? 0),
        withSummary: Number(row.withSummary ?? 0),
        structured: Number(row.structured ?? 0),
        analysisReady: Number(row.analysisReady ?? 0),
        analysisFailed: Number(row.analysisFailed ?? 0),
        explained: Number(row.explained ?? 0),
        withFullText: Number(row.withFullText ?? 0),
        fallbackFullText: Number(row.fallbackFullText ?? 0),
        fullTextFailed: Number(row.fullTextFailed ?? 0),
      })),
      stats.recent,
    );
  } catch (error) {
    console.warn("[content-pipeline] 处理状态统计失败:", (error as Error).message);
    return buildContentPipelineView([], emptyRecent(), false);
  }
}
