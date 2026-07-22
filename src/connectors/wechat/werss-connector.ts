import type {
  CollectContext,
  CollectionResult,
  Connector,
  ConnectorPreview,
  NormalizedItem,
  WechatAccountMonitorConfig,
} from "@/connectors/types";
import { wechatAccountMonitorSchema } from "@/connectors/types";
import { resolveWechatFullText, type WechatFullTextResult } from "@/connectors/wechat/full-text-resolver";
import { wechatStableUpstreamId } from "@/ingestion/deduplicate";
import { signalWithTimeout } from "@/lib/abort-signal";

/**
 * Real WeRSS (rachelos/we-mp-rss) API contract, verified against main branch:
 * - API mounted at `/api/v1` (auth example shows `/api/v1/auth/ak/create`).
 * - List articles: `GET /api/v1/wx/articles?mp_id=&offset=&limit=` -> `{ code, message, data: { list, total } }`.
 * - Resolve a WeChat MP from any article URL: `POST /api/v1/wx/mps/by_article?url=`.
 * - Subscribe an MP: `POST /api/v1/wx/mps` with `{ mp_name, mp_id }`; WeRSS names
 *   the second field `mp_id`, but it expects the raw WeChat biz/faker_id.
 * - Auth: current WeRSS accepts `AK-SK key:secret`; older builds also accept
 *   `Authorization: Bearer <AK>`. `WERSS_ACCESS_KEY` may contain either form.
 */

interface WeRssEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}
interface WeRssArticleList {
  list: WeRssArticle[];
  total: number;
}
interface WeRssArticle {
  id?: string;
  mp_id?: string;
  mp_name?: string;
  title?: string;
  url?: string;
  description?: string;
  pic_url?: string;
  topic_image?: string;
  publish_time?: number;
  author?: string;
  content?: string;
  content_html?: string;
  mp_info?: {
    mp_name?: string;
    logo?: string;
    biz?: string;
    signature?: string;
  };
  [key: string]: unknown;
}

interface ResolvedArticle {
  mpId: string;
  mpName: string;
  /** WeRSS add-subscription calls this `mp_id`, but it is the raw WeChat biz/faker_id. */
  mpBiz?: string;
  mpCover?: string;
  mpIntro?: string;
  article?: WeRssArticle;
}

export interface ResolvedFeed {
  mpId: string;
  mpName: string;
  mpBiz?: string;
  mpCover?: string;
  mpIntro?: string;
}

export interface WeRssFullTextOptions {
  directFallbackEnabled?: boolean;
  fallbackBaseUrl?: string;
  /** Mark the upstream feed unhealthy when WeRSS has not synced it recently. */
  maxFeedStaleHours?: number;
}

export interface WeRssCollectionFeed {
  mpId: string;
  mpName: string;
}

const JIANWEI_COLLECTION_TASK_ID = "jianwei-auto-collect";
const JIANWEI_COLLECTION_TASK_NAME = "见微公众号自动采集（错峰）";

interface WeRssFeedDetail {
  id?: string;
  mp_name?: string;
  sync_time?: number;
  update_time?: number;
}

interface WeRssMessageTask {
  id?: string;
  name?: string;
  mps_id?: string;
  cron_exp?: string;
  status?: number;
}

export interface WeRssSessionStatus {
  authenticated: boolean;
  has_token: boolean;
  account?: string | null;
  expiry_timestamp?: number | null;
  expiry_time?: string | null;
  remaining_seconds?: number | null;
  refreshing?: boolean;
}

export class WeRssConnector implements Connector<"wechat"> {
  constructor(
    private readonly baseUrl: string,
    private readonly accessKey?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly fullTextOptions: WeRssFullTextOptions = {},
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.accessKey) {
      // WeRSS 当前版本要求 `AK-SK key:secret` 格式鉴权；兼容旧版 `Bearer <AK>`。
      headers.Authorization = this.accessKey.includes(":")
        ? `AK-SK ${this.accessKey}`
        : `Bearer ${this.accessKey}`;
    }
    return headers;
  }

  private async readWeRssEnvelope<T>(response: Response, action: string): Promise<WeRssEnvelope<T>> {
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (!response.ok) {
      throw new Error(`${action}:${response.status}:${text.slice(0, 240)}`);
    }

    const envelope = body as WeRssEnvelope<T> & {
      detail?: WeRssEnvelope<unknown>;
    };
    const detail = envelope.detail;
    // WeRSS often reports application errors as HTTP 201 with
    // `{ detail: { code, message } }`, so HTTP success cannot be trusted alone.
    if (detail && typeof detail.code === "number" && detail.code !== 0) {
      throw new Error(`${action}:${detail.code}:${detail.message ?? "WeRSS_ERROR"}`);
    }
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      throw new Error(`${action}:${envelope.code}:${envelope.message ?? "WeRSS_ERROR"}`);
    }
    return envelope;
  }

  private async fetchFeedDetail(mpId: string, signal?: AbortSignal): Promise<WeRssFeedDetail> {
    const response = await this.fetcher(`${this.base}/api/v1/wx/mps/${encodeURIComponent(mpId)}`, {
      headers: this.headers(),
      signal: signalWithTimeout(signal, 10_000),
    });
    const body = await this.readWeRssEnvelope<WeRssFeedDetail>(response, "WERSS_FEED_STATUS_FAILED");
    return body.data ?? {};
  }

  private async assertFeedRecentlySynced(mpId: string, signal?: AbortSignal): Promise<void> {
    const maxHours = Number(this.fullTextOptions.maxFeedStaleHours);
    if (!Number.isFinite(maxHours) || maxHours <= 0) return;

    const feed = await this.fetchFeedDetail(mpId, signal);
    const syncTime = Number(feed.sync_time);
    if (!Number.isFinite(syncTime) || syncTime <= 0) {
      throw new Error("WERSS_FEED_NEVER_SYNCED");
    }
    const ageMs = Date.now() - syncTime * 1000;
    if (ageMs > maxHours * 60 * 60 * 1000) {
      throw new Error(`WERSS_FEED_STALE:${new Date(syncTime * 1000).toISOString()}`);
    }
  }

  /**
   * Keep one WeRSS scheduler task in sync with SignalDeck's enabled account
   * monitors. WeRSS subscriptions alone are static records; without a message
   * task their article lists never refresh.
   */
  async ensureCollectionTask(
    feeds: WeRssCollectionFeed[],
    cronExpression = "17 */3 * * *",
  ): Promise<{ changed: boolean; feedCount: number }> {
    const normalized = feeds
      .filter((feed) => feed.mpId.trim())
      .map((feed) => ({ id: feed.mpId.trim(), name: feed.mpName.trim() || feed.mpId.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (!normalized.length) return { changed: false, feedCount: 0 };

    const listResponse = await this.fetcher(`${this.base}/api/v1/wx/message_tasks?limit=100&offset=0`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    const listBody = await this.readWeRssEnvelope<{ list?: WeRssMessageTask[] }>(
      listResponse,
      "WERSS_TASK_LIST_FAILED",
    );
    const existing = listBody.data?.list?.find((task) => task.id === JIANWEI_COLLECTION_TASK_ID);
    const mpsId = JSON.stringify(normalized);
    let existingMpsId = existing?.mps_id ?? "";
    try {
      existingMpsId = JSON.stringify(JSON.parse(existingMpsId));
    } catch {
      // Keep the raw value so a malformed task is replaced below.
    }
    const unchanged = existing
      && existing.name === JIANWEI_COLLECTION_TASK_NAME
      && existingMpsId === mpsId
      && existing.cron_exp === cronExpression
      && Number(existing.status) === 1;
    if (unchanged) return { changed: false, feedCount: normalized.length };

    const payload = {
      message_template: "",
      web_hook_url: "",
      mps_id: mpsId,
      name: JIANWEI_COLLECTION_TASK_NAME,
      message_type: 1,
      cron_exp: cronExpression,
      status: 1,
      headers: "",
      cookies: "",
    };
    const taskUrl = existing
      ? `${this.base}/api/v1/wx/message_tasks/${JIANWEI_COLLECTION_TASK_ID}`
      : `${this.base}/api/v1/wx/message_tasks`;
    const saveResponse = await this.fetcher(taskUrl, {
      method: existing ? "PUT" : "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    await this.readWeRssEnvelope<unknown>(saveResponse, "WERSS_TASK_SAVE_FAILED");

    const reloadResponse = await this.fetcher(`${this.base}/api/v1/wx/message_tasks/job/fresh`, {
      method: "PUT",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    await this.readWeRssEnvelope<unknown>(reloadResponse, "WERSS_TASK_RELOAD_FAILED");

    const runResponse = await this.fetcher(
      `${this.base}/api/v1/wx/message_tasks/${JIANWEI_COLLECTION_TASK_ID}/run`,
      { headers: this.headers(), signal: AbortSignal.timeout(20_000) },
    );
    await this.readWeRssEnvelope<unknown>(runResponse, "WERSS_TASK_RUN_FAILED");
    return { changed: true, feedCount: normalized.length };
  }

  async health() {
    try {
      const response = await this.fetcher(`${this.base}/api/v1/wx/mps?limit=1`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: response.ok, message: response.ok ? undefined : `WeRSS 返回 ${response.status}` };
    } catch {
      return { ok: false, message: "WeRSS 未启动或无法访问" };
    }
  }

  /** Read sanitized authorization metadata from Jianwei's WeRSS guard. */
  async sessionStatus(): Promise<WeRssSessionStatus> {
    const response = await this.fetcher(`${this.base}/api/v1/wx/auth/session/status`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await this.readWeRssEnvelope<WeRssSessionStatus>(response, "WERSS_AUTH_STATUS_FAILED");
    return body.data ?? { authenticated: false, has_token: false };
  }

  /** Refresh the existing single-account session without creating a QR code. */
  async refreshSession(): Promise<WeRssSessionStatus> {
    const response = await this.fetcher(`${this.base}/api/v1/wx/auth/session/refresh`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await this.readWeRssEnvelope<WeRssSessionStatus>(response, "WERSS_AUTH_REFRESH_FAILED");
    return body.data ?? { authenticated: false, has_token: false };
  }

  private async resolveArticle(articleUrl: string, signal?: AbortSignal): Promise<ResolvedArticle> {
    const url = new URL(`${this.base}/api/v1/wx/mps/by_article`);
    url.searchParams.set("url", articleUrl);
    // NOTE: WeRSS `by_article` internally scrapes the WeChat article page via a
    // headless browser, which routinely takes 15-30s. The default 10s abort would
    // always fire first and fail the collect, so we allow up to 55s here (the
    // worker's outer non-WeChat GATHER_TIMEOUT is 60s; WeChat gets a wider one).
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      signal: signalWithTimeout(signal, 55_000),
    });
    if (!response.ok) throw new Error(`WERSS_RESOLVE_FAILED:${response.status}`);
    const body = await this.readWeRssEnvelope<Record<string, unknown>>(response, "WERSS_RESOLVE_FAILED");

    const data = (body.data ?? {}) as Record<string, unknown>;
    const nestedArticle =
      data.article && typeof data.article === "object"
        ? (data.article as Record<string, unknown>)
        : data;
    const mpInfo =
      data.mp_info && typeof data.mp_info === "object"
        ? (data.mp_info as Record<string, unknown>)
        : nestedArticle.mp_info && typeof nestedArticle.mp_info === "object"
          ? (nestedArticle.mp_info as Record<string, unknown>)
          : {};
    const looksLikeArticle = Boolean(data.title || data.content || data.mp_info || data.article_type);
    const mpId =
      data.mp_id ??
      nestedArticle.mp_id ??
      data.fakeid ??
      nestedArticle.fakeid ??
      mpInfo.mp_id ??
      (!looksLikeArticle ? data.id : undefined);
    const mpName =
      data.mp_name ??
      nestedArticle.mp_name ??
      mpInfo.mp_name ??
      data.nickname ??
      nestedArticle.nickname ??
      data.name ??
      nestedArticle.name;
    const mpBiz =
      data.biz ??
      nestedArticle.biz ??
      data.faker_id ??
      nestedArticle.faker_id ??
      mpInfo.biz;
    const mpCover =
      data.mp_cover ??
      nestedArticle.mp_cover ??
      data.avatar ??
      nestedArticle.avatar ??
      data.logo ??
      nestedArticle.logo ??
      mpInfo.logo;
    const mpIntro =
      data.mp_intro ??
      nestedArticle.mp_intro ??
      data.signature ??
      nestedArticle.signature ??
      mpInfo.signature ??
      data.description ??
      nestedArticle.description;
    if (!mpId) throw new Error("WERSS_FEED_NOT_RESOLVED");

    const article =
      nestedArticle.title || nestedArticle.content
        ? ({
            ...nestedArticle,
            id: nestedArticle.id ?? data.id,
            mp_id: String(mpId),
            mp_name: typeof mpName === "string" ? mpName : undefined,
            url: nestedArticle.url ?? articleUrl,
            pic_url: nestedArticle.pic_url ?? data.topic_image,
            description: nestedArticle.description ?? data.description,
            publish_time: nestedArticle.publish_time ?? data.publish_time,
            content_html: nestedArticle.content_html ?? data.content_html ?? data.content,
            mp_info: mpInfo,
          } as WeRssArticle)
        : undefined;

    return {
      mpId: String(mpId),
      mpName: typeof mpName === "string" && mpName.trim() ? mpName : "未知公众号",
      mpBiz: typeof mpBiz === "string" && mpBiz.trim() ? mpBiz : undefined,
      mpCover: typeof mpCover === "string" && mpCover.trim() ? mpCover : undefined,
      mpIntro: typeof mpIntro === "string" && mpIntro.trim() ? mpIntro : undefined,
      article,
    };
  }

  /** Resolve an article URL to its WeChat MP feed id + name. */
  async resolveFeed(articleUrl: string): Promise<ResolvedFeed> {
    const resolved = await this.resolveArticle(articleUrl);
    return {
      mpId: resolved.mpId,
      mpName: resolved.mpName,
      mpBiz: resolved.mpBiz,
      mpCover: resolved.mpCover,
      mpIntro: resolved.mpIntro,
    };
  }

  /** Ensure the MP is subscribed in WeRSS (idempotent, best-effort). */
  async subscribeResolved(feed: ResolvedFeed, signal?: AbortSignal): Promise<ResolvedFeed> {
    if (!feed.mpBiz) {
      throw new Error("WERSS_SUBSCRIBE_FAILED:missing_mp_biz");
    }

    const response = await this.fetcher(`${this.base}/api/v1/wx/mps`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        mp_name: feed.mpName,
        // WeRSS unfortunately names this field `mp_id`, but the backend
        // decodes it as the raw WeChat biz/faker_id and then derives Feed.id.
        // Passing `MP_WXS_*` here creates an application error hidden behind
        // HTTP 201, so we must pass mp_info.biz from by_article.
        mp_id: feed.mpBiz,
        avatar: feed.mpCover,
        mp_intro: feed.mpIntro,
      }),
      signal: signalWithTimeout(signal, 10_000),
    });
    const body = await this.readWeRssEnvelope<{
      id?: string;
      mp_name?: string;
      mp_cover?: string;
      mp_intro?: string;
      faker_id?: string;
    }>(response, "WERSS_SUBSCRIBE_FAILED");
    const data = body.data ?? {};
    return {
      mpId: data.id || feed.mpId,
      mpName: data.mp_name || feed.mpName,
      mpBiz: data.faker_id || feed.mpBiz,
      mpCover: data.mp_cover || feed.mpCover,
      mpIntro: data.mp_intro || feed.mpIntro,
    };
  }

  /** Ensure the MP is subscribed in WeRSS (idempotent, best-effort). */
  async subscribe(articleUrl: string): Promise<ResolvedFeed> {
    const feed = await this.resolveFeed(articleUrl);
    return this.subscribeResolved(feed);
  }

  /** Cancel a subscription in WeRSS. 见微 only calls this after explicit user confirmation. */
  async unsubscribe(mpId: string): Promise<void> {
    const response = await this.fetcher(`${this.base}/api/v1/wx/mps/${encodeURIComponent(mpId)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    await this.readWeRssEnvelope<unknown>(response, "WERSS_UNSUBSCRIBE_FAILED");
  }

  async validate(config: WechatAccountMonitorConfig): Promise<ConnectorPreview> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    const healthy = await this.health();
    if (!healthy.ok) throw new Error(healthy.message ?? "WERSS_UNAVAILABLE");
    try {
      const resolved = await this.resolveArticle(parsed.articleUrl);
      const articles = await this.fetchArticles(resolved.mpId, 0, 5);
      const fallbackArticle = resolved.article ? [resolved.article] : [];
      const items = (articles.length ? articles : fallbackArticle).map((a) =>
        this.toNormalized(a, resolved.mpId),
      );
      return {
        displayName: items[0]?.authorName ?? resolved.mpName,
        items,
        configPatch: {
          mpId: resolved.mpId,
          mpName: resolved.mpName,
          ...(resolved.mpBiz ? { mpBiz: resolved.mpBiz } : {}),
          ...(resolved.mpCover ? { mpCover: resolved.mpCover } : {}),
          ...(resolved.mpIntro ? { mpIntro: resolved.mpIntro } : {}),
        },
        warning: articles.length
          ? undefined
          : "WeRSS 还没有同步该公众号的历史列表，已先用当前文章作为预览；保存后会继续采集。",
      };
    } catch (err) {
      // Feed not yet resolvable (not subscribed) — still allow saving.
      return {
        displayName: "待 WeRSS 识别公众号",
        items: [],
        warning: `无法解析公众号: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  async collect(
    config: WechatAccountMonitorConfig,
    cursor: Record<string, unknown> = {},
    context?: CollectContext,
  ): Promise<CollectionResult> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    let mpId = typeof cursor.mpId === "string" ? cursor.mpId : parsed.mpId;
    let fallbackArticle: WeRssArticle | undefined;
    let resolvedFeed: ResolvedFeed | undefined;
    if (!mpId) {
      const resolved = await this.resolveArticle(parsed.articleUrl, context?.signal);
      const feed = await this.subscribeResolved({
        mpId: resolved.mpId,
        mpName: resolved.mpName,
        mpBiz: resolved.mpBiz,
        mpCover: resolved.mpCover,
        mpIntro: resolved.mpIntro,
      }, context?.signal);
      mpId = feed.mpId;
      resolvedFeed = feed;
      fallbackArticle = resolved.article;
    }
    if (!resolvedFeed) await this.assertFeedRecentlySynced(mpId, context?.signal);
    // WeRSS returns articles newest-first; always fetch the latest page from
    // offset 0 so each poll picks up newly published posts. We only persist
    // mpId in the cursor (dedupe happens on upsert by upstreamId upstream).
    const limit = 30;
    const articles = await this.fetchArticles(mpId, 0, limit, context?.signal);
    const sourceArticles = articles.length ? articles : fallbackArticle ? [fallbackArticle] : [];
    const items = sourceArticles.map((a) => this.toNormalized(a, mpId));

    // 采集轮次只拉列表，不在这里开 WeRSS 无头浏览器补正文。
    // 每轮对「最新 N 篇」by_article 会在 WeRSS 内泄漏 Playwright 进程（见 2026-07-17 诊断）。
    // 缺正文由 summary-backfill / wechat-content-backfill 按 DB 状态补抓：
    // 直连 → 增强采集器 → WeRSS 浏览器（全局并发 1 + 失败冷却）。
    // 列表若已带 content_html，toNormalized 会直接写入 contentHtml。

    return {
      items,
      cursor: {
        mpId,
        ...(resolvedFeed?.mpName ? { mpName: resolvedFeed.mpName } : {}),
        ...(resolvedFeed?.mpBiz ? { mpBiz: resolvedFeed.mpBiz } : {}),
        ...(resolvedFeed?.mpCover ? { mpCover: resolvedFeed.mpCover } : {}),
        ...(resolvedFeed?.mpIntro ? { mpIntro: resolvedFeed.mpIntro } : {}),
      },
    };
  }

  /**
   * 抓单篇微信文章全文 HTML（by_article 端点，与 resolveFeed 同端点）。
   * 该端点内部用无头浏览器抓微信文章页，约 15–30s，故超时放宽到 30s。
   * 返回去标签前的原始 HTML；失败/超时返回 null（调用方降级）。
   * 调用方必须经 resolveWechatFullText → withWerssBrowserLock，保证全局串行。
   */
  private async fetchFullTextFromWeRss(articleUrl: string): Promise<string | null> {
    const url = new URL(`${this.base}/api/v1/wx/mps/by_article`);
    url.searchParams.set("url", articleUrl);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`WERSS_FULL_TEXT_FAILED:${response.status}`);
    const body = await this.readWeRssEnvelope<Record<string, unknown>>(response, "WERSS_FULL_TEXT_FAILED");
    const data = body.data ?? {};
    const article = (data.article ?? {}) as Record<string, unknown>;
    const html =
      (data.content as string) ||
      (data.content_html as string) ||
      (article.content as string) ||
      (article.content_html as string);
    return typeof html === "string" && html.trim() ? html : null;
  }

  async fetchFullTextResult(articleUrl: string): Promise<WechatFullTextResult> {
    return resolveWechatFullText({
      articleUrl,
      primary: () => this.fetchFullTextFromWeRss(articleUrl),
      directFallbackEnabled: this.fullTextOptions.directFallbackEnabled,
      fallbackBaseUrl: this.fullTextOptions.fallbackBaseUrl,
      fetcher: this.fetcher,
    });
  }

  /** Backward-compatible convenience method used by existing callers. */
  async fetchFullText(articleUrl: string): Promise<string | null> {
    return (await this.fetchFullTextResult(articleUrl)).html;
  }

  private async fetchArticles(
    mpId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<WeRssArticle[]> {
    const url = new URL(`${this.base}/api/v1/wx/articles`);
    url.searchParams.set("mp_id", mpId);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    const response = await this.fetcher(url, {
      headers: this.headers(),
      signal: signalWithTimeout(signal, 15_000),
    });
    const body = await this.readWeRssEnvelope<WeRssArticleList>(response, "WERSS_FETCH_FAILED");
    return body.data?.list ?? [];
  }

  private toNormalized(a: WeRssArticle, mpId: string): NormalizedItem {
    const publishedAt =
      typeof a.publish_time === "number" ? new Date(a.publish_time * 1000) : new Date();
    const text = a.description && a.description.trim() ? a.description : (a.title ?? "");
    const contentHtml = a.content_html ?? a.content ?? undefined;
    const canonicalUrl = a.url ?? "";
    const upstreamId =
      wechatStableUpstreamId(canonicalUrl, typeof a.id === "string" ? a.id : undefined) ??
      `${mpId}:${canonicalUrl || "unknown"}`;
    return {
      platform: "wechat",
      upstreamId,
      canonicalUrl,
      authorId: a.mp_id,
      authorName: a.mp_name ?? a.mp_info?.mp_name,
      title: a.title ?? undefined,
      text,
      contentHtml,
      ...(contentHtml?.trim()
        ? {
            contentProvider: "werss" as const,
            contentFetchStatus: "success" as const,
            contentFetchedAt: new Date(),
          }
        : {}),
      imageUrls: a.pic_url || a.topic_image ? [a.pic_url ?? a.topic_image ?? ""] : [],
      publishedAt,
      raw: a,
    };
  }
}
