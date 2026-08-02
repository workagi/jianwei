import { wechatAccountMonitorSchema, type CollectionResult, type CollectContext, type ConnectorPreview, type NormalizedItem, type WechatAccountMonitorConfig } from "@/connectors/types";
import {
  assertSafeZlzChatEndpoint,
  normalizeZlzChatBaseUrl,
  type ZlzChatDnsLookup,
} from "@/lib/zlzchat-endpoint";

type FetchLike = typeof fetch;

interface ZlzChatFeed {
  wxsId: string;
  mpName?: string;
  mpCover?: string;
  mpIntro?: string;
}

interface ZlzChatArticle {
  articlesId?: string;
  originalId?: string;
  wxsId?: string;
  content?: string;
  contentText?: string;
  links?: string;
  docUrl?: string;
  mpName?: string;
  imgUrl?: string;
  picUrl?: string;
  title?: string;
  publishTime?: string | number;
  [key: string]: unknown;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

interface ZlzChatPage<T> {
  rows: T[];
  total?: number;
}

const circuits = new Map<string, CircuitState>();
const TRANSIENT_RETRY_DELAY_MS = 300;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function rowsFromEnvelope(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("ZLZCHAT_SCHEMA_MISMATCH:expected a list envelope");
  }
  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.rows)) return root.rows;
  if (Array.isArray(root.list)) return root.list;
  if (Array.isArray(root.data)) return root.data;
  if (root.data && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data.records)) return data.records;
  }
  throw new Error("ZLZCHAT_SCHEMA_MISMATCH:expected rows/list/records");
}

function totalFromEnvelope(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const rootTotal = numberValue(root.total);
  if (rootTotal !== undefined) return rootTotal;
  if (root.data && typeof root.data === "object") {
    return numberValue((root.data as Record<string, unknown>).total);
  }
  return undefined;
}

function envelopeMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as Record<string, unknown>;
  const nested = root.data && typeof root.data === "object"
    ? stringValue((root.data as Record<string, unknown>).msg)
      ?? stringValue((root.data as Record<string, unknown>).message)
    : undefined;
  return stringValue(root.msg) ?? stringValue(root.message) ?? nested ?? "";
}

function envelopeCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const rootCode = numberValue(root.code);
  const nestedCode = root.data && typeof root.data === "object"
    ? numberValue((root.data as Record<string, unknown>).code)
    : undefined;
  // Some deployments wrap an application error in an HTTP-success envelope
  // (`root.code=200`, `data.code=500`). Prefer the nested non-success code so
  // callers cannot mistake a failed sync for an empty successful response.
  if (nestedCode !== undefined && nestedCode !== 0 && nestedCode !== 200) return nestedCode;
  if (rootCode !== undefined) return rootCode;
  return nestedCode;
}

function envelopeExplicitFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as Record<string, unknown>;
  for (const value of [root.success, root.ok]) {
    if (typeof value === "boolean" && !value) return true;
  }
  return false;
}

function providerError(message: string): Error | null {
  const value = message.trim();
  if (!value) return null;
  if (/请先设置key值|key值不匹配|未授权|鉴权失败/i.test(value)) return new Error(`ZLZCHAT_AUTH_REQUIRED:${value}`);
  if (/请勿频繁|频繁请求|限流|稍后再试|风险/i.test(value)) return new Error(`ZLZCHAT_RATE_LIMITED:${value}`);
  if (/无可用账号|账号禁用|服务不可用/i.test(value)) return new Error(`ZLZCHAT_UNAVAILABLE:${value}`);
  if (/链接异常|公众号不存在|无法找到/i.test(value)) return new Error(`ZLZCHAT_SOURCE_NOT_FOUND:${value}`);
  if (/失败|错误|异常/i.test(value)) return new Error(`ZLZCHAT_INVALID_RESPONSE:${value}`);
  return null;
}

function parseDate(value: unknown, fallback = new Date()): Date {
  const numeric = numberValue(value);
  if (numeric !== undefined) {
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const text = stringValue(value);
  if (text) {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? text.replace(" ", "T") + "+08:00"
      : text;
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) return date;
  }
  // Invalid upstream dates must not silently become 1970-01-01.  A current
  // fallback keeps the item visible and sortable while preserving the raw
  // provider payload for later reconciliation.
  return fallback;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function articleUrl(article: ZlzChatArticle): string | undefined {
  for (const candidate of [article.links, article.docUrl]) {
    const value = stringValue(candidate);
    if (!value) continue;
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol)) return url.toString();
    } catch {
      // Ignore malformed upstream URLs instead of exposing them to the reader.
    }
  }
  return undefined;
}

function toFeed(row: unknown): ZlzChatFeed | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const wxsId = stringValue(value.wxsId ?? value.wxs_id);
  if (!wxsId) return null;
  return {
    wxsId,
    mpName: stringValue(value.mpName ?? value.mp_name),
    mpCover: stringValue(value.mpCover ?? value.mp_cover),
    mpIntro: stringValue(value.mpIntro ?? value.mp_intro),
  };
}

function toArticle(row: unknown): ZlzChatArticle | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return {
    ...value,
    articlesId: stringValue(value.articlesId ?? value.articles_id),
    originalId: stringValue(value.originalId ?? value.original_id),
    wxsId: stringValue(value.wxsId ?? value.wxs_id),
    content: stringValue(value.content),
    contentText: stringValue(value.contentText ?? value.content_text),
    links: stringValue(value.links),
    docUrl: stringValue(value.docUrl ?? value.doc_url),
    mpName: stringValue(value.mpName ?? value.mp_name),
    imgUrl: stringValue(value.imgUrl ?? value.img_url),
    picUrl: stringValue(value.picUrl ?? value.pic_url),
    title: stringValue(value.title),
    publishTime: (value.publishTime ?? value.publish_time) as string | number | undefined,
  };
}

function articleKey(article: ZlzChatArticle): string | undefined {
  return article.articlesId ?? article.originalId ?? articleUrl(article);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("ZLZCHAT_ABORTED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("ZLZCHAT_ABORTED"));
    }, { once: true });
  });
}

export class ZlzChatConnector {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly failureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly allowedOrigins?: string;
  private readonly dnsLookup?: ZlzChatDnsLookup;

  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly fetcher: FetchLike = fetch,
    options: {
      timeoutMs?: number;
      pageSize?: number;
      maxPages?: number;
      failureThreshold?: number;
      circuitOpenMs?: number;
      allowedOrigins?: string;
      dnsLookup?: ZlzChatDnsLookup;
    } = {},
  ) {
    this.base = normalizeZlzChatBaseUrl(baseUrl);
    this.apiKey = apiKey.trim();
    if (!this.apiKey) throw new Error("ZLZCHAT_API_KEY_MISSING");
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);
    this.pageSize = Math.min(100, Math.max(1, options.pageSize ?? 30));
    this.maxPages = Math.min(100, Math.max(1, options.maxPages ?? 20));
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.circuitOpenMs = Math.max(10_000, options.circuitOpenMs ?? 10 * 60_000);
    this.allowedOrigins = options.allowedOrigins;
    this.dnsLookup = options.dnsLookup;
  }

  private requestUrl(path: string, query: Record<string, string | number | undefined>): URL {
    const url = new URL(path, `${this.base}/`);
    url.searchParams.set("key", this.apiKey);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && String(value).trim()) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private circuit(): CircuitState {
    return circuits.get(this.base) ?? { failures: 0, openUntil: 0 };
  }

  private recordSuccess(): void {
    circuits.delete(this.base);
  }

  private recordFailure(): void {
    const current = this.circuit();
    const failures = current.failures + 1;
    circuits.set(this.base, {
      failures,
      openUntil: failures >= this.failureThreshold ? Date.now() + this.circuitOpenMs : 0,
    });
  }

  private async request(path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<unknown> {
    const circuit = this.circuit();
    if (circuit.openUntil > Date.now()) throw new Error("ZLZCHAT_CIRCUIT_OPEN");

    let lastError: unknown;
    let lastFailureWasTransient = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("ZLZCHAT_ABORTED");
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        await assertSafeZlzChatEndpoint(this.base, {
          allowedOrigins: this.allowedOrigins,
          lookup: this.dnsLookup,
        });
        const response = await this.fetcher(this.requestUrl(path, query), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: requestSignal,
          cache: "no-store",
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) throw new Error("ZLZCHAT_REDIRECT_FORBIDDEN");
        if (response.status === 401 || response.status === 403) throw new Error(`ZLZCHAT_AUTH_REQUIRED:${response.status}`);
        if (response.status === 429) throw new Error("ZLZCHAT_RATE_LIMITED:429");
        if (response.status >= 500) throw new Error(`ZLZCHAT_UNAVAILABLE:${response.status}`);
        if (!response.ok) throw new Error(`ZLZCHAT_REQUEST_FAILED:${response.status}`);
        const payload = await response.json() as unknown;
        if (envelopeExplicitFailure(payload)) {
          throw new Error(`ZLZCHAT_INVALID_RESPONSE:${envelopeMessage(payload) || "success=false"}`);
        }
        const code = envelopeCode(payload);
        if (code !== undefined && code !== 0 && code !== 200) {
          throw new Error(`ZLZCHAT_INVALID_RESPONSE:${code}:${envelopeMessage(payload) || "unknown"}`);
        }
        const knownError = providerError(envelopeMessage(payload));
        if (knownError) throw knownError;
        this.recordSuccess();
        return payload;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /ZLZCHAT_UNAVAILABLE|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|timeout/i.test(message);
        lastFailureWasTransient = retryable;
        if (!retryable || attempt === 1 || signal?.aborted) break;
        await abortableDelay(TRANSIENT_RETRY_DELAY_MS, signal);
      }
    }
    if (lastFailureWasTransient) this.recordFailure();
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (/timeout|TimeoutError|aborted due to timeout/i.test(message)) throw new Error("ZLZCHAT_TIMEOUT");
    throw lastError instanceof Error ? lastError : new Error(`ZLZCHAT_REQUEST_FAILED:${message}`);
  }

  private async feeds(signal?: AbortSignal): Promise<ZlzChatFeed[]> {
    const payload = await this.request("feedList", {
      pageNum: 1,
      pageSize: 100,
      orderByColumn: "create_time",
      isAsc: "desc",
      serarKey: "",
    }, signal);
    return rowsFromEnvelope(payload).map(toFeed).filter((feed): feed is ZlzChatFeed => feed !== null);
  }

  private async articlesPage(wxsId: string, pageNum: number, signal?: AbortSignal): Promise<ZlzChatPage<ZlzChatArticle>> {
    const payload = await this.request("getFeedArticleList", {
      wxsId,
      pageNum,
      pageSize: this.pageSize,
      orderByColumn: "publish_time",
      isAsc: "desc",
      searchKey: "",
    }, signal);
    return {
      rows: rowsFromEnvelope(payload).map(toArticle).filter((article): article is ZlzChatArticle => article !== null),
      total: totalFromEnvelope(payload),
    };
  }

  private async latestArticles(wxsId: string, signal?: AbortSignal): Promise<ZlzChatArticle[]> {
    return (await this.articlesPage(wxsId, 1, signal)).rows;
  }

  private async articlesSince(
    wxsId: string,
    previousNewestKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ articles: ZlzChatArticle[]; newestKey?: string }> {
    // A newly-created monitor establishes a recent baseline from page one.
    // Walking an account's entire history here can make a large, existing feed
    // impossible to initialize when it exceeds the safety cap. Subsequent runs
    // have a durable boundary and must walk every page until they reach it.
    if (!previousNewestKey) {
      const firstPage = await this.articlesPage(wxsId, 1, signal);
      const seen = new Set<string>();
      const articles = firstPage.rows.filter((article) => {
        const key = articleKey(article);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { articles, newestKey: firstPage.rows.map(articleKey).find(Boolean) };
    }

    const collected: ZlzChatArticle[] = [];
    const seen = new Set<string>();
    let newestKey: string | undefined;
    let reachedPreviousBoundary = false;
    let reachedEnd = false;

    for (let pageNum = 1; pageNum <= this.maxPages; pageNum += 1) {
      const page = await this.articlesPage(wxsId, pageNum, signal);
      if (pageNum === 1) newestKey = page.rows.map(articleKey).find(Boolean);

      for (const article of page.rows) {
        const key = articleKey(article);
        if (key === previousNewestKey) {
          reachedPreviousBoundary = true;
          break;
        }
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(article);
      }

      if (reachedPreviousBoundary) break;
      reachedEnd = page.rows.length < this.pageSize
        || (page.total !== undefined && pageNum * this.pageSize >= page.total);
      if (reachedEnd) break;
    }

    if (!reachedPreviousBoundary && !reachedEnd) {
      throw new Error("ZLZCHAT_BACKLOG_EXCEEDED");
    }
    return { articles: collected, newestKey };
  }

  private async resolveFeed(config: WechatAccountMonitorConfig, signal?: AbortSignal): Promise<ZlzChatFeed> {
    if (config.zlzchatWxsId) {
      return {
        wxsId: config.zlzchatWxsId,
        mpName: config.mpName,
        mpCover: config.mpCover,
        mpIntro: config.mpIntro,
      };
    }

    const before = await this.feeds(signal);
    const beforeIds = new Set(before.map((feed) => feed.wxsId));
    const payload = await this.request("addFeedUrl", { linkUrl: config.articleUrl }, signal);
    const message = envelopeMessage(payload);
    if (/已添加|已存在/.test(message)) {
      throw new Error("ZLZCHAT_WXS_ID_REQUIRED:该公众号已在 zlzchat 中，请从 zlzchat 后台复制 wxsId 后重试");
    }
    if (message && !/成功|订阅/.test(message)) {
      throw new Error(`ZLZCHAT_SUBSCRIBE_FAILED:${message}`);
    }
    const after = await this.feeds(signal);
    const added = after.filter((feed) => !beforeIds.has(feed.wxsId));
    if (added.length !== 1) {
      throw new Error("ZLZCHAT_WXS_ID_REQUIRED:无法唯一识别新订阅，请从 zlzchat 后台复制 wxsId 后重试");
    }
    return added[0];
  }

  private async existingFeed(config: WechatAccountMonitorConfig): Promise<ZlzChatFeed> {
    if (!config.zlzchatWxsId) {
      throw new Error("ZLZCHAT_WXS_ID_REQUIRED:请先在 ZLZChat 后台复制该公众号的 wxsId");
    }
    return {
      wxsId: config.zlzchatWxsId,
      mpName: config.mpName,
      mpCover: config.mpCover,
      mpIntro: config.mpIntro,
    };
  }

  private async previewForFeed(feed: ZlzChatFeed): Promise<ConnectorPreview> {
    const items = (await this.latestArticles(feed.wxsId))
      .map((article) => this.normalized(article, feed))
      .filter((item): item is NormalizedItem => item !== null)
      .slice(0, 5);
    return {
      displayName: items[0]?.authorName ?? feed.mpName ?? "微信公众号",
      avatarUrl: feed.mpCover,
      items,
      configPatch: {
        provider: "zlzchat",
        zlzchatWxsId: feed.wxsId,
        ...(feed.mpName ? { mpName: feed.mpName } : {}),
        ...(feed.mpCover ? { mpCover: feed.mpCover } : {}),
        ...(feed.mpIntro ? { mpIntro: feed.mpIntro } : {}),
      },
      warning: items.length ? undefined : "zlzchat 已识别公众号，但暂未同步出文章；请确认 zlzchat 的定时同步任务已启用。",
    };
  }

  private normalized(article: ZlzChatArticle, feed: ZlzChatFeed): NormalizedItem | null {
    const canonicalUrl = articleUrl(article);
    if (!canonicalUrl) return null;
    const html = stringValue(article.content);
    const text = stringValue(article.contentText) ?? (html ? stripHtml(html) : undefined) ?? article.title ?? "";
    const imageUrls = [article.picUrl, article.imgUrl].filter((value): value is string => Boolean(value));
    return {
      platform: "wechat",
      sourceProvider: "wechat_zlzchat",
      upstreamId: article.articlesId ?? article.originalId ?? canonicalUrl,
      canonicalUrl,
      authorId: article.wxsId ?? feed.wxsId,
      authorName: article.mpName ?? feed.mpName ?? "微信公众号",
      avatarUrl: feed.mpCover,
      title: article.title,
      text,
      contentHtml: html,
      contentProvider: html ? "zlzchat" : undefined,
      imageUrls: [...new Set(imageUrls)],
      publishedAt: parseDate(article.publishTime),
      raw: article,
    };
  }

  async validate(config: WechatAccountMonitorConfig): Promise<ConnectorPreview> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    if (!parsed.zlzchatWxsId) {
      return {
        displayName: parsed.mpName ?? "微信公众号",
        items: [],
        warning: "预览不会创建订阅。首次使用请直接保存，见微会显式调用 ZLZChat 订阅接口；已有订阅请先填写 wxsId。",
      };
    }
    return this.previewForFeed(await this.existingFeed(parsed));
  }

  /** Explicit write operation used only by monitor create/update handlers. */
  async subscribe(config: WechatAccountMonitorConfig): Promise<ConnectorPreview> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    const feed = parsed.zlzchatWxsId
      ? await this.existingFeed(parsed)
      : await this.resolveFeed(parsed);
    return this.previewForFeed(feed);
  }

  async collect(
    config: WechatAccountMonitorConfig,
    cursor: Record<string, unknown> = {},
    context?: CollectContext,
  ): Promise<CollectionResult> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    const cursorWxsId = stringValue(cursor.zlzchatWxsId);
    const wxsId = cursorWxsId ?? parsed.zlzchatWxsId;
    if (!wxsId) throw new Error("ZLZCHAT_WXS_ID_REQUIRED:监控尚未绑定 wxsId，请先保存并完成订阅");
    const feed = await this.existingFeed({ ...parsed, zlzchatWxsId: wxsId });
    const previousNewestKey = stringValue(cursor.zlzchatNewestArticleKey);
    const page = await this.articlesSince(feed.wxsId, previousNewestKey, context?.signal);
    const items = page.articles.map((article) => this.normalized(article, feed)).filter((item): item is NormalizedItem => item !== null);
    const nextNewestKey = page.newestKey ?? previousNewestKey;
    return {
      items,
      cursor: {
        zlzchatWxsId: feed.wxsId,
        ...(nextNewestKey ? { zlzchatNewestArticleKey: nextNewestKey } : {}),
      },
    };
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.feeds();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
