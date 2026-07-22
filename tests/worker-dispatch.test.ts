import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

function mockFetch(handler: (url: URL, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) =>
    handler(input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url), init)) as typeof fetch;
}

describe("worker gather() dispatch — Task 3 P1 + P2 (direct connectors)", () => {
  beforeEach(() => {
    process.env.X_BEARER_TOKEN = "test-token";
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    process.env.TAVILY_API_KEY = "tvly-test";
    process.env.SERPER_API_KEY = "serper-test";
    process.env.WERSS_BASE_URL = "http://werss:8001";
    process.env.WERSS_ACCESS_KEY = "test-ak";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.X_BEARER_TOKEN;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.WERSS_BASE_URL;
    delete process.env.WERSS_ACCESS_KEY;
  });

  it("collects X posts and advances the sinceId cursor", async () => {
    mockFetch((url) => {
      if (url.pathname.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "u1", name: "OpenAI", username: "OpenAI" } }), { status: 200 });
      }
      if (url.pathname.includes("/users/u1/tweets")) {
        return new Response(JSON.stringify({ data: [{ id: "t1", text: "hello world" }], meta: { newest_id: "t1" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({
      platform: "x",
      config: { username: "OpenAI", includeReplies: false, includeReposts: false },
      cursor: {},
    });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].platform).toBe("x");
    expect(out.items[0].sourceProvider).toBe("x_official");
    expect(out.items[0].upstreamId).toBe("t1");
    expect(out.cursor.sinceId).toBe("t1");
  });

  it("collects Brave search results normalized to web_search items", async () => {
    mockFetch((url) => {
      if (url.hostname === "api.search.brave.com") {
        return new Response(
          JSON.stringify({
            web: { results: [{ title: "AI agent A", url: "https://a.com/x", description: "desc a", profile: { name: "Site A" } }] },
            news: { results: [{ title: "AI agent B", url: "https://b.com/y", description: "desc b", profile: { name: "Site B" } }] },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({ platform: "web_search", config: { query: "AI agent" }, cursor: {} });

    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.every((i) => i.platform === "web_search")).toBe(true);
    expect(out.items.every((i) => i.sourceProvider === "web_brave")).toBe(true);
    expect(out.items[0].authorName).toBe("Site A");
    expect(out.cursor).toHaveProperty("collectedAt");
  });

  it("uses Brave News Search when the monitor asks for news only", async () => {
    let requestedPath = "";
    mockFetch((url) => {
      requestedPath = url.pathname;
      if (url.hostname === "api.search.brave.com") {
        return new Response(
          JSON.stringify({
            results: [{ title: "Momenta news", url: "https://news.example.com/momenta", description: "Momenta update", page_age: "2026-07-14T10:00:00Z", profile: { name: "News Example" } }],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({ platform: "web_search", config: { provider: "brave", query: "Momenta", resultType: "news" }, cursor: {} });

    expect(requestedPath).toBe("/res/v1/news/search");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("Momenta news");
    expect(out.items[0].authorName).toBe("News Example");
  });

  it("collects Tavily search results when selected as web_search provider", async () => {
    mockFetch((url) => {
      if (url.hostname === "api.tavily.com") {
        return new Response(
          JSON.stringify({
            results: [{ title: "AI agent Tavily A", url: "https://example.com/a", content: "summary a" }],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({ platform: "web_search", config: { provider: "tavily", query: "AI agent" }, cursor: {} });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("AI agent Tavily A");
    expect(out.items[0].authorName).toBe("example.com");
    expect(out.items[0].sourceProvider).toBe("web_tavily");
    expect(out.cursor.provider).toBe("tavily");
  });

  it("collects Serper search results when selected as web_search provider", async () => {
    mockFetch((url) => {
      if (url.hostname === "google.serper.dev") {
        return new Response(
          JSON.stringify({
            organic: [{ title: "Serper A", link: "https://example.com/s", snippet: "AI agent snippet s", source: "Example" }],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({ platform: "web_search", config: { provider: "serper", query: "AI agent" }, cursor: {} });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("Serper A");
    expect(out.items[0].authorName).toBe("Example");
    expect(out.items[0].sourceProvider).toBe("web_serper");
    expect(out.cursor.provider).toBe("serper");
  });

  it("collects WeRSS articles after resolving the MP feed (P2)", async () => {
    const articles = [
      { id: "a1", mp_id: "mpX", title: "T1", url: "https://mp.weixin.qq.com/s/a1", description: "D1", publish_time: 1_700_000_000, pic_url: "https://img/1.jpg", mp_name: "账号X" },
      { id: "a2", mp_id: "mpX", title: "T2", url: "https://mp.weixin.qq.com/s/a2", description: "D2", publish_time: 1_700_001_000, mp_name: "账号X" },
    ];
    mockFetch((url) => {
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        return new Response(JSON.stringify({ code: 0, message: "ok", data: { mp_id: "mpX", mp_name: "账号X", mp_info: { biz: "bizX" } } }), { status: 200 });
      }
      if (url.pathname === "/api/v1/wx/mps") {
        return new Response(JSON.stringify({ code: 0, message: "ok", data: { id: "mpX", mp_name: "账号X", faker_id: "bizX" } }), { status: 200 });
      }
      if (url.pathname === "/api/v1/wx/articles") {
        return new Response(JSON.stringify({ code: 0, message: "ok", data: { list: articles, total: 2 } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const { gather } = await import("@/worker");
    const out = await gather({
      platform: "wechat",
      config: { articleUrl: "https://mp.weixin.qq.com/s/abc", provider: "werss" },
      cursor: {},
    });

    expect(out.items).toHaveLength(2);
    expect(out.items[0].platform).toBe("wechat");
    expect(out.items[0].sourceProvider).toBe("wechat_werss");
    expect(out.items[0].upstreamId).toBe("a1");
    expect(out.items[0].authorName).toBe("账号X");
    expect(out.items[0].canonicalUrl).toBe("https://mp.weixin.qq.com/s/a1");
    expect(out.items[0].imageUrls).toEqual(["https://img/1.jpg"]);
    expect(out.cursor).toMatchObject({ mpId: "mpX", mpName: "账号X", mpBiz: "bizX" });
  });
});

describe("worker monitor circuit breaker", () => {
  it("auto-disables a monitor once consecutive failures reach the threshold", async () => {
    const { shouldDisableMonitorAfterFailure } = await import("@/worker");

    expect(shouldDisableMonitorAfterFailure(4, 5)).toBe(false);
    expect(shouldDisableMonitorAfterFailure(5, 5)).toBe(true);
    expect(shouldDisableMonitorAfterFailure(10, 0)).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "XAI_X_SEARCH_503")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "XAI_X_SEARCH_429")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "XAI_X_SEARCH_NETWORK:UND_ERR_SOCKET")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "XAI_X_SEARCH_TIMEOUT")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "GATHER_TIMEOUT:x")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "fetch failed")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "WERSS_FEED_STALE:2026-07-19T10:00:00.000Z")).toBe(false);
    expect(shouldDisableMonitorAfterFailure(10, 5, "WERSS_FEED_NEVER_SYNCED")).toBe(false);
  });
});
