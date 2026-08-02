import { describe, expect, it, vi } from "vitest";
import { ZlzChatConnector } from "@/connectors/wechat/zlzchat-connector";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

function connector(
  baseUrl: string,
  apiKey: string,
  fetcher: typeof fetch,
  options: ConstructorParameters<typeof ZlzChatConnector>[3] = {},
) {
  return new ZlzChatConnector(baseUrl, apiKey, fetcher, { ...options, dnsLookup: publicDns });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(extra: Record<string, unknown> = {}) {
  return {
    kind: "account" as const,
    provider: "zlzchat" as const,
    articleUrl: "https://mp.weixin.qq.com/s/example",
    ...extra,
  };
}

describe("ZlzChatConnector", () => {
  it("reads nested table envelopes and normalizes camel/snake case articles", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/feedList")) {
        return json({ code: 200, msg: "获取成功", data: { rows: [{ wxs_id: "wx-1", mp_name: "苍何", mp_cover: "https://img.test/avatar.jpg" }] } });
      }
      return json({
        code: 200,
        msg: "获取成功",
        data: {
          rows: [{
            articles_id: "article-1",
            wxs_id: "wx-1",
            mp_name: "苍何",
            title: "一篇文章",
            links: "https://mp.weixin.qq.com/s/article-1",
            content_text: "文章正文",
            pic_url: "https://img.test/cover.jpg",
            publish_time: "2026-07-31 08:00:00",
          }],
        },
      });
    });
    const client = connector("http://zlzchat.test:805", "secret", fetcher as typeof fetch);

    const result = await client.collect(config({ zlzchatWxsId: "wx-1" }), {});

    expect(result.cursor.zlzchatWxsId).toBe("wx-1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceProvider: "wechat_zlzchat",
      upstreamId: "article-1",
      authorName: "苍何",
      text: "文章正文",
      canonicalUrl: "https://mp.weixin.qq.com/s/article-1",
    });
  });

  it("explicitly subscribes a new feed and resolves exactly one newly-created wxsId", async () => {
    let feedCalls = 0;
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/feedList")) {
        feedCalls += 1;
        return json({ code: 200, data: { rows: feedCalls === 1 ? [] : [{ wxsId: "wx-new", mpName: "宝玉" }] } });
      }
      if (url.pathname.endsWith("/addFeedUrl")) return json({ code: 200, msg: "订阅成功！" });
      if (url.pathname.endsWith("/getFeedArticleList")) return json({ code: 200, data: { rows: [] } });
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = connector("http://new-subscription.test:805", "secret", fetcher as typeof fetch);

    const preview = await client.subscribe(config());

    expect(preview.displayName).toBe("宝玉");
    expect(preview.configPatch).toMatchObject({ provider: "zlzchat", zlzchatWxsId: "wx-new", mpName: "宝玉" });
    expect(preview.warning).toContain("定时同步");
  });

  it("keeps validation read-only when no wxsId has been supplied", async () => {
    const fetcher = vi.fn(async () => json({ code: 200, data: { rows: [] } }));
    const client = connector("http://readonly-validate.test:805", "secret", fetcher as typeof fetch);

    const preview = await client.validate(config());

    expect(preview.items).toEqual([]);
    expect(preview.warning).toContain("不会创建订阅");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires an explicit wxsId instead of guessing when the feed already exists", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/feedList")) return json({ code: 200, data: { rows: [{ wxsId: "existing", mpName: "已有公众号" }] } });
      return json({ code: 200, msg: "该公众号已添加！" });
    });
    const client = connector("http://existing-feed.test:805", "secret", fetcher as typeof fetch);

    await expect(client.subscribe(config())).rejects.toThrow("ZLZCHAT_WXS_ID_REQUIRED");
  });

  it("detects authentication errors even when the upstream returns HTTP 200 and a success-shaped code", async () => {
    const fetcher = vi.fn(async () => json({ code: 200, msg: "key值不匹配" }));
    const client = connector("http://bad-key.test:805", "wrong", fetcher as typeof fetch);

    await expect(client.health()).resolves.toEqual({
      ok: false,
      message: "ZLZCHAT_AUTH_REQUIRED:key值不匹配",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrecognized success envelope instead of treating it as an empty feed", async () => {
    const fetcher = vi.fn(async () => json({ code: 200, data: { foo: [] } }));
    const client = connector("http://schema-mismatch.test:805", "secret", fetcher as typeof fetch);

    await expect(client.health()).resolves.toEqual({
      ok: false,
      message: "ZLZCHAT_SCHEMA_MISMATCH:expected rows/list/records",
    });
  });

  it("rejects nested provider errors and explicit success=false envelopes", async () => {
    const nestedError = vi.fn(async () => json({ code: 200, data: { code: 500, message: "同步失败" } }));
    const nestedClient = connector("https://nested-error.test", "secret", nestedError as typeof fetch);
    await expect(nestedClient.health()).resolves.toEqual({
      ok: false,
      message: "ZLZCHAT_INVALID_RESPONSE:500:同步失败",
    });

    const explicitFailure = vi.fn(async () => json({ success: false, data: { rows: [] }, message: "失败" }));
    const failureClient = connector("https://explicit-failure.test", "secret", explicitFailure as typeof fetch);
    await expect(failureClient.health()).resolves.toEqual({
      ok: false,
      message: "ZLZCHAT_INVALID_RESPONSE:失败",
    });
  });

  it("does not turn an invalid publish date into the Unix epoch", async () => {
    const fetcher = vi.fn(async () => json({
      code: 200,
      data: {
        rows: [{
          articlesId: "bad-date",
          links: "https://mp.weixin.qq.com/s/bad-date",
          title: "日期异常",
          publishTime: "not-a-date",
        }],
      },
    }));
    const client = connector("https://invalid-date.test", "secret", fetcher as typeof fetch);
    const before = Date.now();

    const result = await client.collect(config({ zlzchatWxsId: "wx-1" }), {});

    expect(result.items[0]?.publishedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("rejects credentials embedded in the base URL", () => {
    expect(() => new ZlzChatConnector("http://user:pass@zlzchat.test:805", "secret")).toThrow("ZLZCHAT_BASE_URL_INVALID");
  });

  it("refuses the upstream public demo as a production credential target", () => {
    expect(() => new ZlzChatConnector("http://111.229.83.152:805", "secret")).toThrow("ZLZCHAT_PUBLIC_DEMO_FORBIDDEN");
  });

  it("retries one transient upstream failure without retrying authentication failures", async () => {
    const transient = vi.fn()
      .mockResolvedValueOnce(json({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(json({ code: 200, data: { rows: [] } }));
    const client = connector("http://transient.test:805", "secret", transient as typeof fetch);

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(transient).toHaveBeenCalledTimes(2);

    const auth = vi.fn(async () => json({ code: 200, msg: "请先设置key值" }));
    const authConnector = connector("http://auth-no-retry.test:805", "secret", auth as typeof fetch);
    await expect(authConnector.health()).resolves.toMatchObject({ ok: false });
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("walks pages until the previous stable article boundary without gaps", async () => {
    const requestedPages: number[] = [];
    const rowsByPage: Record<number, Record<string, unknown>[]> = {
      1: [
        { articlesId: "new-3", links: "https://mp.weixin.qq.com/s/new-3", title: "new 3" },
        { articlesId: "new-2", links: "https://mp.weixin.qq.com/s/new-2", title: "new 2" },
      ],
      2: [
        { articlesId: "new-1", links: "https://mp.weixin.qq.com/s/new-1", title: "new 1" },
        { articlesId: "old-boundary", links: "https://mp.weixin.qq.com/s/old", title: "old" },
      ],
    };
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pageNum = Number(url.searchParams.get("pageNum"));
      requestedPages.push(pageNum);
      return json({ code: 200, data: { rows: rowsByPage[pageNum] ?? [], total: 5 } });
    });
    const client = connector("https://paged.test", "secret", fetcher as typeof fetch, { pageSize: 2, maxPages: 4 });

    const result = await client.collect(config({ zlzchatWxsId: "wx-1" }), {
      zlzchatWxsId: "wx-1",
      zlzchatNewestArticleKey: "old-boundary",
    });

    expect(requestedPages).toEqual([1, 2]);
    expect(result.items.map((item) => item.upstreamId)).toEqual(["new-3", "new-2", "new-1"]);
    expect(result.cursor).toEqual({ zlzchatWxsId: "wx-1", zlzchatNewestArticleKey: "new-3" });
  });

  it("collects 65 new articles across three pages before the previous boundary", async () => {
    const requestedPages: number[] = [];
    const newRows = Array.from({ length: 65 }, (_, index) => ({
      articlesId: `new-${65 - index}`,
      links: `https://mp.weixin.qq.com/s/new-${65 - index}`,
    }));
    const allRows = [
      ...newRows,
      { articlesId: "old-boundary", links: "https://mp.weixin.qq.com/s/old-boundary" },
    ];
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pageNum = Number(url.searchParams.get("pageNum"));
      const pageSize = Number(url.searchParams.get("pageSize"));
      requestedPages.push(pageNum);
      const start = (pageNum - 1) * pageSize;
      return json({ code: 200, data: { rows: allRows.slice(start, start + pageSize), total: allRows.length } });
    });
    const client = connector("https://three-pages.test", "secret", fetcher as typeof fetch, { pageSize: 25, maxPages: 4 });

    const result = await client.collect(config({ zlzchatWxsId: "wx-1" }), {
      zlzchatWxsId: "wx-1",
      zlzchatNewestArticleKey: "old-boundary",
    });

    expect(requestedPages).toEqual([1, 2, 3]);
    expect(result.items).toHaveLength(65);
    expect(new Set(result.items.map((item) => item.upstreamId))).toHaveLength(65);
    expect(result.cursor.zlzchatNewestArticleKey).toBe("new-65");
  });

  it("initializes a new monitor from page one without walking all history", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return json({
        code: 200,
        data: {
          rows: [
            { articlesId: `page-${url.searchParams.get("pageNum")}-a`, links: "https://mp.weixin.qq.com/s/a" },
            { articlesId: `page-${url.searchParams.get("pageNum")}-b`, links: "https://mp.weixin.qq.com/s/b" },
          ],
          total: 200,
        },
      });
    });
    const client = connector("https://initial.test", "secret", fetcher as typeof fetch, { pageSize: 2, maxPages: 2 });

    const result = await client.collect(config({ zlzchatWxsId: "wx-1" }), { zlzchatWxsId: "wx-1" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(2);
    expect(result.cursor.zlzchatNewestArticleKey).toBe("page-1-a");
  });

  it("fails closed when the old boundary is beyond the configured page cap", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("pageNum");
      return json({
        code: 200,
        data: {
          rows: [
            { articlesId: `${page}-a`, links: `https://mp.weixin.qq.com/s/${page}-a` },
            { articlesId: `${page}-b`, links: `https://mp.weixin.qq.com/s/${page}-b` },
          ],
        },
      });
    });
    const client = connector("https://backlog.test", "secret", fetcher as typeof fetch, { pageSize: 2, maxPages: 2 });

    await expect(client.collect(config({ zlzchatWxsId: "wx-1" }), {
      zlzchatWxsId: "wx-1",
      zlzchatNewestArticleKey: "not-in-window",
    })).rejects.toThrow("ZLZCHAT_BACKLOG_EXCEEDED");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not follow redirects from the configured upstream", async () => {
    let receivedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      receivedInit = args[1];
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });
    const client = connector("https://redirect.test", "secret", fetcher as typeof fetch);

    await expect(client.health()).resolves.toEqual({ ok: false, message: "ZLZCHAT_REDIRECT_FORBIDDEN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(receivedInit).toMatchObject({ redirect: "manual" });
  });
});
