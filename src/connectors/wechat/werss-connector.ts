import type {
  CollectionResult,
  Connector,
  ConnectorPreview,
  NormalizedItem,
  WechatAccountMonitorConfig,
} from "@/connectors/types";
import { wechatAccountMonitorSchema } from "@/connectors/types";
// 仅在「微信摘要真正启用」时才值得为每篇文章花 ~22s 抓全文：
// 该守卫按 process.env 实时读取后台保存的开关，避免无谓地拖慢采集。
import { isSummaryActiveFor } from "@/lib/summarizer";

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

interface ResolvedFeed {
  mpId: string;
  mpName: string;
  mpBiz?: string;
  mpCover?: string;
  mpIntro?: string;
}

export class WeRssConnector implements Connector<"wechat"> {
  constructor(
    private readonly baseUrl: string,
    private readonly accessKey?: string,
    private readonly fetcher: typeof fetch = fetch,
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

  private async resolveArticle(articleUrl: string): Promise<ResolvedArticle> {
    const url = new URL(`${this.base}/api/v1/wx/mps/by_article`);
    url.searchParams.set("url", articleUrl);
    // NOTE: WeRSS `by_article` internally scrapes the WeChat article page via a
    // headless browser, which routinely takes 15-30s. The default 10s abort would
    // always fire first and fail the collect, so we allow up to 55s here (the
    // worker's outer non-WeChat GATHER_TIMEOUT is 60s; WeChat gets a wider one).
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(55_000),
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
  async subscribe(articleUrl: string): Promise<ResolvedFeed> {
    const feed = await this.resolveFeed(articleUrl);
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
      signal: AbortSignal.timeout(10_000),
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

  async collect(config: WechatAccountMonitorConfig, cursor: Record<string, unknown> = {}): Promise<CollectionResult> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    let mpId = typeof cursor.mpId === "string" ? cursor.mpId : undefined;
    let fallbackArticle: WeRssArticle | undefined;
    if (!mpId) {
      const resolved = await this.resolveArticle(parsed.articleUrl);
      mpId = resolved.mpId;
      fallbackArticle = resolved.article;
    }
    // WeRSS returns articles newest-first; always fetch the latest page from
    // offset 0 so each poll picks up newly published posts. We only persist
    // mpId in the cursor (dedupe happens on upsert by upstreamId upstream).
    const limit = 30;
    const articles = await this.fetchArticles(mpId, 0, limit);
    const sourceArticles = articles.length ? articles : fallbackArticle ? [fallbackArticle] : [];
    const items = sourceArticles.map((a) => this.toNormalized(a, mpId));

    // 仅当微信摘要真正启用（后台已配置 provider 且未跳过 wechat）时，
    // 为最近若干篇（最新优先，默认最多 6 篇）抓全文，供 summarizer 生成
    // 「读完全文」的真摘要。列表接口本身不返回正文，只有 by_article 才返回。
    // 抓不到全文的文章 contentHtml 保持空，summarizer 会跳过它（不会生成引子式伪摘要）。
    if (isSummaryActiveFor("wechat")) {
      const targets = items
        .filter((it) => it.canonicalUrl && !(it.contentHtml && it.contentHtml.trim()))
        .slice(0, 6);
      await this.fetchFullTexts(targets);
    }

    return { items, cursor: { mpId } };
  }

  /**
   * 并发（最多 3）抓取若干微信文章的全文 HTML。单篇失败/超时静默跳过，
   * 不抛错、不影响其它文章的采集。上限 6 篇 × 30s / 并发 3 ≈ 60s，
   * 远在 worker 给微信的 180s 采集预算内。
   */
  private async fetchFullTexts(targets: NormalizedItem[]): Promise<void> {
    if (!targets.length) return;
    const CONCURRENCY = 3;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const item = targets[cursor++];
        const html = await this.fetchFullText(item.canonicalUrl);
        if (html) item.contentHtml = html;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  }

  /**
   * 抓单篇微信文章全文 HTML（by_article 端点，与 resolveFeed 同端点）。
   * 该端点内部用无头浏览器抓微信文章页，约 15–30s，故超时放宽到 30s。
   * 返回去标签前的原始 HTML；失败/超时返回 null（调用方降级）。
   */
  async fetchFullText(articleUrl: string): Promise<string | null> {
    try {
      const url = new URL(`${this.base}/api/v1/wx/mps/by_article`);
      url.searchParams.set("url", articleUrl);
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const body = await this.readWeRssEnvelope<Record<string, unknown>>(response, "WERSS_FULL_TEXT_FAILED");
      const data = body.data ?? {};
      const article = (data.article ?? {}) as Record<string, unknown>;
      const html =
        (data.content as string) ||
        (data.content_html as string) ||
        (article.content as string) ||
        (article.content_html as string);
      return typeof html === "string" && html.trim() ? html : null;
    } catch {
      return null;
    }
  }

  private async fetchArticles(mpId: string, offset: number, limit: number): Promise<WeRssArticle[]> {
    const url = new URL(`${this.base}/api/v1/wx/articles`);
    url.searchParams.set("mp_id", mpId);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    const response = await this.fetcher(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    const body = await this.readWeRssEnvelope<WeRssArticleList>(response, "WERSS_FETCH_FAILED");
    return body.data?.list ?? [];
  }

  private toNormalized(a: WeRssArticle, mpId: string): NormalizedItem {
    const publishedAt =
      typeof a.publish_time === "number" ? new Date(a.publish_time * 1000) : new Date();
    const text = a.description && a.description.trim() ? a.description : (a.title ?? "");
    return {
      platform: "wechat",
      upstreamId: a.id ?? `${mpId}:${a.url ?? ""}`,
      canonicalUrl: a.url ?? "",
      authorId: a.mp_id,
      authorName: a.mp_name ?? a.mp_info?.mp_name,
      title: a.title ?? undefined,
      text,
      contentHtml: a.content_html ?? a.content ?? undefined,
      imageUrls: a.pic_url || a.topic_image ? [a.pic_url ?? a.topic_image ?? ""] : [],
      publishedAt,
      raw: a,
    };
  }
}
