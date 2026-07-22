import { createStructuredLogger } from "@/lib/structured-log";

const fullTextLog = createStructuredLogger({ service: "wechat-full-text" });

export type WechatContentProvider = "werss" | "direct" | "wechat_download_api";
export type WechatContentFetchStatus = "success" | "failed";

export interface WechatFullTextResult {
  html: string | null;
  status: WechatContentFetchStatus;
  provider?: WechatContentProvider;
  errorCode?: string;
  attempts: string[];
}

export interface ResolveWechatFullTextInput {
  articleUrl: string;
  /** WeRSS headless-browser path. Called last; must be serialized process-wide. */
  primary: () => Promise<string | null>;
  directFallbackEnabled?: boolean;
  fallbackBaseUrl?: string;
  fetcher?: typeof fetch;
  /** Skip WeRSS browser path (tests / circuit open). */
  skipWerssBrowser?: boolean;
}

const BLOCK_PAGE_MARKERS = [
  "环境异常",
  "访问过于频繁",
  "完成验证",
  "扫码验证",
  "请求过于频繁",
  "该内容已被发布者删除",
];

/** Default hours before a failed full-text fetch may be retried. */
export function wechatFullTextRetryHours(): number {
  const parsed = Number(process.env.WECHAT_FULLTEXT_RETRY_HOURS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 6;
  return Math.min(parsed, 168);
}

/** True when a prior failure is still inside the retry cooldown window. */
export function isWithinFullTextCooldown(
  status: string | null | undefined,
  fetchedAt: Date | string | null | undefined,
  cooldownHours = wechatFullTextRetryHours(),
): boolean {
  if (status !== "failed" || !fetchedAt) return false;
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(at.getTime())) return false;
  return Date.now() - at.getTime() < cooldownHours * 3_600_000;
}

function positiveInt(envName: string, fallback: number, max: number): number {
  const parsed = Number(process.env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Minimum gap between WeRSS browser calls from this process (ms). */
export function werssBrowserMinGapMs(): number {
  return positiveInt("WECHAT_WERSS_BROWSER_MIN_GAP_MS", 5_000, 120_000);
}

/** Soft budget: max WeRSS browser calls per rolling hour from this process. */
export function werssBrowserMaxPerHour(): number {
  return positiveInt("WECHAT_WERSS_BROWSER_MAX_PER_HOUR", 36, 500);
}

/** Consecutive WeRSS browser failures before opening the circuit. */
export function werssBrowserCircuitFailures(): number {
  return positiveInt("WECHAT_WERSS_BROWSER_CIRCUIT_FAILURES", 4, 50);
}

/** How long the circuit stays open (minutes). */
export function werssBrowserCircuitMinutes(): number {
  return positiveInt("WECHAT_WERSS_BROWSER_CIRCUIT_MINUTES", 30, 24 * 60);
}

/**
 * Process-wide throttle + circuit breaker for WeRSS headless browser work.
 * Concurrent / unbounded by_article calls leaked Playwright processes and
 * saturated the host (2026-07-17). Keep the feature, but never stampede it.
 */
type WerssBrowserGuardState = {
  tail: Promise<unknown>;
  lastStartedAt: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  hourWindowStart: number;
  hourCallCount: number;
};

const guard: WerssBrowserGuardState = {
  tail: Promise.resolve(),
  lastStartedAt: 0,
  consecutiveFailures: 0,
  circuitOpenUntil: 0,
  hourWindowStart: 0,
  hourCallCount: 0,
};

/** Test/helper: reset in-memory throttle state. */
export function resetWerssBrowserGuardForTests(): void {
  guard.tail = Promise.resolve();
  guard.lastStartedAt = 0;
  guard.consecutiveFailures = 0;
  guard.circuitOpenUntil = 0;
  guard.hourWindowStart = 0;
  guard.hourCallCount = 0;
}

export function getWerssBrowserGuardSnapshot(): {
  circuitOpen: boolean;
  circuitOpenUntil: number;
  consecutiveFailures: number;
  hourCallCount: number;
} {
  return {
    circuitOpen: Date.now() < guard.circuitOpenUntil,
    circuitOpenUntil: guard.circuitOpenUntil,
    consecutiveFailures: guard.consecutiveFailures,
    hourCallCount: guard.hourCallCount,
  };
}

export function isWerssBrowserCircuitOpen(now = Date.now()): boolean {
  return now < guard.circuitOpenUntil;
}

function noteHourlyCall(now: number): "ok" | "budget_exhausted" {
  const hourMs = 3_600_000;
  if (now - guard.hourWindowStart >= hourMs) {
    guard.hourWindowStart = now;
    guard.hourCallCount = 0;
  }
  if (guard.hourCallCount >= werssBrowserMaxPerHour()) return "budget_exhausted";
  guard.hourCallCount += 1;
  return "ok";
}

function openCircuit(now: number, reason: string): void {
  const until = now + werssBrowserCircuitMinutes() * 60_000;
  guard.circuitOpenUntil = Math.max(guard.circuitOpenUntil, until);
  fullTextLog.warn("werss.browser.circuit_opened", {
    circuitOpenUntil: new Date(guard.circuitOpenUntil),
    reason,
    hourlyCallCount: guard.hourCallCount,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize WeRSS browser work and enforce min-gap + hourly budget + circuit.
 * Throws Error with code-like message when skipped by guard (callers map to attempts).
 */
export async function withWerssBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = guard.tail;
  guard.tail = gate;
  await previous.then(
    () => undefined,
    () => undefined,
  );

  try {
    const now = Date.now();
    if (now < guard.circuitOpenUntil) {
      throw new Error("WERSS_BROWSER_CIRCUIT_OPEN");
    }
    const budget = noteHourlyCall(now);
    if (budget === "budget_exhausted") {
      openCircuit(now, `hourly budget ${werssBrowserMaxPerHour()}`);
      throw new Error("WERSS_BROWSER_BUDGET_EXHAUSTED");
    }
    const gap = werssBrowserMinGapMs();
    const wait = guard.lastStartedAt + gap - now;
    if (wait > 0) await sleep(wait);
    guard.lastStartedAt = Date.now();

    try {
      const result = await fn();
      guard.consecutiveFailures = 0;
      return result;
    } catch (error) {
      guard.consecutiveFailures += 1;
      if (guard.consecutiveFailures >= werssBrowserCircuitFailures()) {
        openCircuit(Date.now(), `${guard.consecutiveFailures} consecutive failures`);
      }
      throw error;
    }
  } finally {
    release();
  }
}

function plainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulContent(html: string | null | undefined): html is string {
  if (!html?.trim()) return false;
  const text = plainText(html);
  if (text.length < 20) return false;
  return !BLOCK_PAGE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Extract the balanced contents of WeChat's `#js_content` container without a
 * DOM dependency. The scanner counts nested div tags so it does not truncate at
 * the first child closing tag like a simple regular expression would.
 */
export function extractWechatArticleContent(pageHtml: string): string | null {
  if (!pageHtml || BLOCK_PAGE_MARKERS.some((marker) => pageHtml.includes(marker))) return null;
  const opening = /<div\b[^>]*\bid\s*=\s*(["'])js_content\1[^>]*>/i.exec(pageHtml);
  if (!opening || opening.index === undefined) return null;

  const contentStart = opening.index + opening[0].length;
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(pageHtml))) {
    if (/^<\/div/i.test(match[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) {
      const content = pageHtml.slice(contentStart, match.index).trim();
      return meaningfulContent(content) ? content : null;
    }
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchDirectArticle(
  articleUrl: string,
  fetcher: typeof fetch,
): Promise<{ html: string | null; error?: string }> {
  try {
    const response = await fetcher(articleUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { html: null, error: `direct_http_${response.status}` };
    const html = extractWechatArticleContent(await response.text());
    return html ? { html } : { html: null, error: "direct_no_content" };
  } catch {
    return { html: null, error: "direct_failed" };
  }
}

async function fetchWechatDownloadApi(
  baseUrl: string,
  articleUrl: string,
  fetcher: typeof fetch,
): Promise<{ html: string | null; error?: string }> {
  try {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/article`;
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ url: articleUrl }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { html: null, error: `fallback_http_${response.status}` };
    const body = (await response.json()) as {
      success?: boolean;
      data?: { content?: unknown; plain_content?: unknown } | null;
    };
    if (body.success !== true || !body.data) return { html: null, error: "fallback_rejected" };
    const html = typeof body.data.content === "string" ? body.data.content : "";
    if (meaningfulContent(html)) return { html };
    const plain = typeof body.data.plain_content === "string" ? body.data.plain_content.trim() : "";
    if (plain.length >= 20) return { html: `<p>${escapeHtml(plain)}</p>` };
    return { html: null, error: "fallback_no_content" };
  } catch {
    return { html: null, error: "fallback_failed" };
  }
}

/**
 * Resolve article HTML without letting a full-text failure break collection.
 *
 * Order is intentional and load-safe:
 * 1. public article page (no browser)
 * 2. enhanced collector API (wechat-download-api)
 * 3. WeRSS headless browser last, under a process-wide lock + throttle + circuit
 */
export async function resolveWechatFullText(input: ResolveWechatFullTextInput): Promise<WechatFullTextResult> {
  const fetcher = input.fetcher ?? fetch;
  const attempts: string[] = [];

  if (input.directFallbackEnabled !== false) {
    const direct = await fetchDirectArticle(input.articleUrl, fetcher);
    if (direct.html) {
      return { html: direct.html, status: "success", provider: "direct", attempts: ["direct"] };
    }
    attempts.push(direct.error ?? "direct_failed");
  }

  if (input.fallbackBaseUrl?.trim()) {
    const fallback = await fetchWechatDownloadApi(input.fallbackBaseUrl.trim(), input.articleUrl, fetcher);
    if (fallback.html) {
      return {
        html: fallback.html,
        status: "success",
        provider: "wechat_download_api",
        attempts: [...attempts, "wechat_download_api"],
      };
    }
    attempts.push(fallback.error ?? "fallback_failed");
  }

  if (input.skipWerssBrowser || isWerssBrowserCircuitOpen()) {
    attempts.push(isWerssBrowserCircuitOpen() ? "werss_circuit_open" : "werss_skipped");
    return {
      html: null,
      status: "failed",
      errorCode: attempts.join(",").slice(0, 240),
      attempts,
    };
  }

  try {
    const primary = await withWerssBrowserLock(() => input.primary());
    if (meaningfulContent(primary)) {
      return { html: primary, status: "success", provider: "werss", attempts: [...attempts, "werss"] };
    }
    // Empty body is a soft failure for circuit purposes: still counts toward
    // consecutive issues so a wedged WeRSS stops being hammered.
    guard.consecutiveFailures += 1;
    if (guard.consecutiveFailures >= werssBrowserCircuitFailures()) {
      openCircuit(Date.now(), `${guard.consecutiveFailures} empty/failed browser bodies`);
    }
    attempts.push("werss_empty");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("CIRCUIT_OPEN")) attempts.push("werss_circuit_open");
    else if (message.includes("BUDGET_EXHAUSTED")) attempts.push("werss_budget_exhausted");
    else attempts.push("werss_failed");
  }

  return {
    html: null,
    status: "failed",
    errorCode: attempts.join(",").slice(0, 240) || "no_full_text_source",
    attempts,
  };
}
