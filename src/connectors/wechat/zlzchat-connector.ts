import { wechatAccountMonitorSchema, type CollectionResult, type CollectContext, type ConnectorPreview, type NormalizedItem, type WechatAccountMonitorConfig } from "@/connectors/types";

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
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.rows)) return root.rows;
  if (Array.isArray(root.data)) return root.data;
  if (root.data && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.records)) return data.records;
  }
  return [];
}

function envelopeMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as Record<string, unknown>;
  const nested = root.data && typeof root.data === "object"
    ? stringValue((root.data as Record<string, unknown>).msg)
    : undefined;
  return stringValue(root.msg) ?? nested ?? "";
}

function envelopeCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return numberValue((payload as Record<string, unknown>).code);
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

function normalizeBaseUrl(raw: string): string {
  if (!raw.trim()) throw new Error("ZLZCHAT_BASE_URL_MISSING");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("ZLZCHAT_BASE_URL_INVALID");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("ZLZCHAT_BASE_URL_INVALID");
  }
  if (url.hostname === "111.229.83.152") {
    throw new Error("ZLZCHAT_PUBLIC_DEMO_FORBIDDEN");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseDate(value: unknown): Date {
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
  return new Date(0);
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
  private readonly failureThreshold: number;
  private readonly circuitOpenMs: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly fetcher: FetchLike = fetch,
    options: {
      timeoutMs?: number;
      pageSize?: number;
      failureThreshold?: number;
      circuitOpenMs?: number;
    } = {},
  ) {
    this.base = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey.trim();
    if (!this.apiKey) throw new Error("ZLZCHAT_API_KEY_MISSING");
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);
    this.pageSize = Math.min(100, Math.max(1, options.pageSize ?? 30));
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.circuitOpenMs = Math.max(10_000, options.circuitOpenMs ?? 10 * 60_000);
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
        const response = await this.fetcher(this.requestUrl(path, query), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: requestSignal,
          cache: "no-store",
        });
        if (response.status === 401 || response.status === 403) throw new Error(`ZLZCHAT_AUTH_REQUIRED:${response.status}`);
        if (response.status === 429) throw new Error("ZLZCHAT_RATE_LIMITED:429");
        if (response.status >= 500) throw new Error(`ZLZCHAT_UNAVAILABLE:${response.status}`);
        if (!response.ok) throw new Error(`ZLZCHAT_REQUEST_FAILED:${response.status}`);
        const payload = await response.json() as unknown;
        const knownError = providerError(envelopeMessage(payload));
        if (knownError) throw knownError;
        const code = envelopeCode(payload);
        if (code !== undefined && code !== 0 && code !== 200) {
          throw new Error(`ZLZCHAT_INVALID_RESPONSE:${code}:${envelopeMessage(payload) || "unknown"}`);
        }
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

  private async articles(wxsId: string, signal?: AbortSignal): Promise<ZlzChatArticle[]> {
    const payload = await this.request("getFeedArticleList", {
      wxsId,
      pageNum: 1,
      pageSize: this.pageSize,
      orderByColumn: "publish_time",
      isAsc: "desc",
      searchKey: "",
    }, signal);
    return rowsFromEnvelope(payload).map(toArticle).filter((article): article is ZlzChatArticle => article !== null);
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
    const feed = await this.resolveFeed(parsed);
    const items = (await this.articles(feed.wxsId)).map((article) => this.normalized(article, feed)).filter((item): item is NormalizedItem => item !== null).slice(0, 5);
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

  async collect(
    config: WechatAccountMonitorConfig,
    cursor: Record<string, unknown> = {},
    context?: CollectContext,
  ): Promise<CollectionResult> {
    const parsed = wechatAccountMonitorSchema.parse(config);
    const cursorWxsId = stringValue(cursor.zlzchatWxsId);
    const feed = await this.resolveFeed({ ...parsed, zlzchatWxsId: cursorWxsId ?? parsed.zlzchatWxsId }, context?.signal);
    const items = (await this.articles(feed.wxsId, context?.signal)).map((article) => this.normalized(article, feed)).filter((item): item is NormalizedItem => item !== null);
    return {
      items,
      cursor: {
        zlzchatWxsId: feed.wxsId,
        lastSeenAt: new Date().toISOString(),
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
