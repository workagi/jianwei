import { describe, expect, it, vi } from "vitest";
import { ZlzChatConnector } from "@/connectors/wechat/zlzchat-connector";

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
    const connector = new ZlzChatConnector("http://zlzchat.test:805", "secret", fetcher as typeof fetch);

    const result = await connector.collect(config({ zlzchatWxsId: "wx-1" }), {});

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

  it("subscribes a new feed and resolves exactly one newly-created wxsId", async () => {
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
    const connector = new ZlzChatConnector("http://new-subscription.test:805", "secret", fetcher as typeof fetch);

    const preview = await connector.validate(config());

    expect(preview.displayName).toBe("宝玉");
    expect(preview.configPatch).toMatchObject({ provider: "zlzchat", zlzchatWxsId: "wx-new", mpName: "宝玉" });
    expect(preview.warning).toContain("定时同步");
  });

  it("requires an explicit wxsId instead of guessing when the feed already exists", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/feedList")) return json({ code: 200, data: { rows: [{ wxsId: "existing", mpName: "已有公众号" }] } });
      return json({ code: 200, msg: "该公众号已添加！" });
    });
    const connector = new ZlzChatConnector("http://existing-feed.test:805", "secret", fetcher as typeof fetch);

    await expect(connector.validate(config())).rejects.toThrow("ZLZCHAT_WXS_ID_REQUIRED");
  });

  it("detects authentication errors even when the upstream returns HTTP 200 and a success-shaped code", async () => {
    const fetcher = vi.fn(async () => json({ code: 200, msg: "key值不匹配" }));
    const connector = new ZlzChatConnector("http://bad-key.test:805", "wrong", fetcher as typeof fetch);

    await expect(connector.health()).resolves.toEqual({
      ok: false,
      message: "ZLZCHAT_AUTH_REQUIRED:key值不匹配",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    const connector = new ZlzChatConnector("http://transient.test:805", "secret", transient as typeof fetch);

    await expect(connector.health()).resolves.toEqual({ ok: true });
    expect(transient).toHaveBeenCalledTimes(2);

    const auth = vi.fn(async () => json({ code: 200, msg: "请先设置key值" }));
    const authConnector = new ZlzChatConnector("http://auth-no-retry.test:805", "secret", auth as typeof fetch);
    await expect(authConnector.health()).resolves.toMatchObject({ ok: false });
    expect(auth).toHaveBeenCalledTimes(1);
  });
});
