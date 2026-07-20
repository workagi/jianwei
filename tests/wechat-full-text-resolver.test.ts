import { afterEach, describe, expect, it } from "vitest";
import {
  extractWechatArticleContent,
  getWerssBrowserGuardSnapshot,
  isWithinFullTextCooldown,
  resetWerssBrowserGuardForTests,
  resolveWechatFullText,
  withWerssBrowserLock,
} from "@/connectors/wechat/full-text-resolver";

const ARTICLE_URL = "https://mp.weixin.qq.com/s/example";
const LONG_TEXT = "这是一段用于验证微信公众号正文解析的内容。".repeat(8);

function response(body: string | object, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
  });
}

describe("extractWechatArticleContent", () => {
  it("extracts the complete balanced js_content body", () => {
    const html = `<html><body><div id="js_content" class="rich_media_content"><section>${LONG_TEXT}<div><p>嵌套内容</p></div></section></div><script>ignored()</script></body></html>`;
    const content = extractWechatArticleContent(html);

    expect(content).toContain(LONG_TEXT);
    expect(content).toContain("嵌套内容");
    expect(content).not.toContain("ignored()");
  });

  it("rejects WeChat verification/challenge pages", () => {
    const html = `<html><body><div id="js_content">环境异常，请完成验证后继续访问。${LONG_TEXT}</div></body></html>`;
    expect(extractWechatArticleContent(html)).toBeNull();
  });
});

describe("isWithinFullTextCooldown", () => {
  it("blocks retries only for recent failures", () => {
    expect(isWithinFullTextCooldown("failed", new Date(), 6)).toBe(true);
    expect(isWithinFullTextCooldown("success", new Date(), 6)).toBe(false);
    expect(isWithinFullTextCooldown("failed", new Date(Date.now() - 7 * 3_600_000), 6)).toBe(false);
    expect(isWithinFullTextCooldown("failed", null, 6)).toBe(false);
  });
});

afterEach(() => {
  resetWerssBrowserGuardForTests();
  delete process.env.WECHAT_WERSS_BROWSER_MIN_GAP_MS;
  delete process.env.WECHAT_WERSS_BROWSER_MAX_PER_HOUR;
  delete process.env.WECHAT_WERSS_BROWSER_CIRCUIT_FAILURES;
  delete process.env.WECHAT_WERSS_BROWSER_CIRCUIT_MINUTES;
});

describe("WeRSS browser guard", () => {
  it("serializes browser work and enforces an hourly budget then opens the circuit", async () => {
    process.env.WECHAT_WERSS_BROWSER_MIN_GAP_MS = "1";
    process.env.WECHAT_WERSS_BROWSER_MAX_PER_HOUR = "2";
    process.env.WECHAT_WERSS_BROWSER_CIRCUIT_MINUTES = "10";

    await withWerssBrowserLock(async () => "a");
    await withWerssBrowserLock(async () => "b");
    await expect(withWerssBrowserLock(async () => "c")).rejects.toThrow("BUDGET_EXHAUSTED");
    expect(getWerssBrowserGuardSnapshot().circuitOpen).toBe(true);
  });

  it("opens the circuit after consecutive failures", async () => {
    process.env.WECHAT_WERSS_BROWSER_MIN_GAP_MS = "1";
    process.env.WECHAT_WERSS_BROWSER_MAX_PER_HOUR = "100";
    process.env.WECHAT_WERSS_BROWSER_CIRCUIT_FAILURES = "2";
    process.env.WECHAT_WERSS_BROWSER_CIRCUIT_MINUTES = "10";

    await expect(withWerssBrowserLock(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(withWerssBrowserLock(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(getWerssBrowserGuardSnapshot().circuitOpen).toBe(true);
    await expect(withWerssBrowserLock(async () => "ok")).rejects.toThrow("CIRCUIT_OPEN");
  });
});

describe("resolveWechatFullText", () => {
  it("uses the public article page first and never opens WeRSS when direct succeeds", async () => {
    let primaryCalls = 0;
    const fetcher = (async (input: string | URL) => {
      expect(String(input)).toBe(ARTICLE_URL);
      return response(`<html><div id="js_content"><p>${LONG_TEXT}</p></div></html>`);
    }) as typeof fetch;

    const result = await resolveWechatFullText({
      articleUrl: ARTICLE_URL,
      primary: async () => {
        primaryCalls += 1;
        return `<p>${LONG_TEXT}</p>`;
      },
      directFallbackEnabled: true,
      fallbackBaseUrl: "http://wechat-fallback:5000",
      fetcher,
    });

    expect(result).toMatchObject({ status: "success", provider: "direct" });
    expect(primaryCalls).toBe(0);
  });

  it("uses wechat-download-api after the direct page is blocked, before WeRSS", async () => {
    let primaryCalls = 0;
    const calls: string[] = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === ARTICLE_URL) return response("<html>访问过于频繁，请稍后再试</html>");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ url: ARTICLE_URL });
      return response({ success: true, data: { content: `<article>${LONG_TEXT}</article>` }, error: null });
    }) as typeof fetch;

    const result = await resolveWechatFullText({
      articleUrl: ARTICLE_URL,
      primary: async () => {
        primaryCalls += 1;
        return null;
      },
      directFallbackEnabled: true,
      fallbackBaseUrl: "http://wechat-fallback:5000/",
      fetcher,
    });

    expect(calls).toEqual([ARTICLE_URL, "http://wechat-fallback:5000/api/article"]);
    expect(result).toMatchObject({ status: "success", provider: "wechat_download_api" });
    expect(primaryCalls).toBe(0);
  });

  it("falls back to WeRSS browser only after direct and enhanced collector fail", async () => {
    let primaryCalls = 0;
    const fetcher = (async (input: string | URL) => {
      if (String(input) === ARTICLE_URL) return response("<html>访问过于频繁</html>");
      return response({ success: false, data: null, error: "登录过期" });
    }) as typeof fetch;

    const result = await resolveWechatFullText({
      articleUrl: ARTICLE_URL,
      primary: async () => {
        primaryCalls += 1;
        return `<p>${LONG_TEXT}</p>`;
      },
      directFallbackEnabled: true,
      fallbackBaseUrl: "http://wechat-fallback:5000",
      fetcher,
    });

    expect(primaryCalls).toBe(1);
    expect(result).toMatchObject({ status: "success", provider: "werss" });
    expect(result.attempts).toContain("werss");
  });

  it("returns a compact failure result when every configured source fails", async () => {
    process.env.WECHAT_WERSS_BROWSER_MIN_GAP_MS = "1";
    const fetcher = (async () => response({ success: false, data: null, error: "登录过期" })) as typeof fetch;
    const result = await resolveWechatFullText({
      articleUrl: ARTICLE_URL,
      primary: async () => {
        throw new Error("secret upstream response");
      },
      directFallbackEnabled: false,
      fallbackBaseUrl: "http://wechat-fallback:5000",
      fetcher,
    });

    expect(result.status).toBe("failed");
    expect(result.html).toBeNull();
    expect(result.errorCode).toContain("werss_failed");
    expect(result.errorCode).toContain("fallback_rejected");
    expect(result.errorCode).not.toContain("secret upstream response");
  });

  it("skips WeRSS browser when the circuit is already open", async () => {
    process.env.WECHAT_WERSS_BROWSER_MIN_GAP_MS = "1";
    process.env.WECHAT_WERSS_BROWSER_MAX_PER_HOUR = "1";
    process.env.WECHAT_WERSS_BROWSER_CIRCUIT_MINUTES = "10";
    // Exhaust budget to open circuit.
    await withWerssBrowserLock(async () => "once");
    await expect(withWerssBrowserLock(async () => "twice")).rejects.toThrow("BUDGET");

    let primaryCalls = 0;
    const result = await resolveWechatFullText({
      articleUrl: ARTICLE_URL,
      primary: async () => {
        primaryCalls += 1;
        return `<p>${LONG_TEXT}</p>`;
      },
      directFallbackEnabled: false,
      fetcher: (async () => response("", 500)) as typeof fetch,
    });

    expect(primaryCalls).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toContain("werss_circuit_open");
  });
});
