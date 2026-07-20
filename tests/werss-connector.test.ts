import { describe, expect, it } from "vitest";
import { WeRssConnector } from "@/connectors/wechat/werss-connector";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WeRssConnector", () => {
  it("subscribes with the WeChat biz/faker_id that WeRSS expects instead of the derived MP_WXS id", async () => {
    const requests: Array<{ pathname: string; body?: unknown }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input);
      requests.push({
        pathname: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        return response({
          code: 0,
          data: {
            title: "文章",
            mp_id: "MP_WXS_3934419561",
            mp_info: {
              mp_name: "赛博禅心",
              biz: "MzkzNDQxOTU2MQ==",
              logo: "https://img.example.com/logo.jpg",
              signature: "公众号简介",
            },
          },
        });
      }
      if (url.pathname === "/api/v1/wx/mps") {
        return response({
          code: 0,
          data: {
            id: "MP_WXS_3934419561",
            mp_name: "赛博禅心",
            faker_id: "MzkzNDQxOTU2MQ==",
          },
        });
      }
      return response({}, 404);
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    const feed = await connector.subscribe("https://mp.weixin.qq.com/s/f16Fr2f4VAOowvQXeUX_nA");

    expect(feed).toMatchObject({
      mpId: "MP_WXS_3934419561",
      mpName: "赛博禅心",
      mpBiz: "MzkzNDQxOTU2MQ==",
    });
    expect(requests.find((r) => r.pathname === "/api/v1/wx/mps")?.body).toMatchObject({
      mp_name: "赛博禅心",
      mp_id: "MzkzNDQxOTU2MQ==",
      avatar: "https://img.example.com/logo.jpg",
      mp_intro: "公众号简介",
    });
  });

  it("treats WeRSS HTTP 201 error envelopes as subscribe failures", async () => {
    const fetcher = (async (input: string | URL) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        return response({
          code: 0,
          data: {
            mp_id: "MP_WXS_3934419561",
            mp_info: { mp_name: "赛博禅心", biz: "MzkzNDQxOTU2MQ==" },
          },
        });
      }
      if (url.pathname === "/api/v1/wx/mps") {
        return response(
          {
            detail: {
              code: 50001,
              message: "添加公众号失败",
            },
          },
          201,
        );
      }
      return response({}, 404);
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    await expect(connector.subscribe("https://mp.weixin.qq.com/s/f16Fr2f4VAOowvQXeUX_nA")).rejects.toThrow(
      "WERSS_SUBSCRIBE_FAILED:50001",
    );
  });

  it("falls back to the resolved article when a newly resolved MP has no list items yet", async () => {
    const fetcher = (async (input: string | URL) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.pathname === "/api/v1/wx/mps" && url.searchParams.get("limit") === "1") {
        return response({ code: 0, data: { list: [], total: 0 } });
      }
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        return response({
          code: 0,
          message: "success",
          data: {
            id: "f16Fr2f4VAOowvQXeUX_nA",
            title: "视频解说 Skill：教你分清「柯基」与「吐司面包」",
            description: "青年大学习",
            content: "<p>正文</p>",
            topic_image: "https://img.example.com/cover.jpg",
            publish_time: 1_784_015_460,
            mp_id: "MP_WXS_3934419561",
            mp_info: { mp_name: "赛博禅心" },
          },
        });
      }
      if (url.pathname === "/api/v1/wx/articles") {
        return response({ code: 0, data: { list: [], total: 0 } });
      }
      return response({}, 404);
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    const preview = await connector.validate({
      provider: "werss",
      articleUrl: "https://mp.weixin.qq.com/s/f16Fr2f4VAOowvQXeUX_nA",
    });

    expect(preview.displayName).toBe("赛博禅心");
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].title).toBe("视频解说 Skill：教你分清「柯基」与「吐司面包」");
    expect(preview.items[0].authorName).toBe("赛博禅心");
    expect(preview.items[0].canonicalUrl).toBe("https://mp.weixin.qq.com/s/f16Fr2f4VAOowvQXeUX_nA");
    expect(preview.configPatch).toMatchObject({
      mpId: "MP_WXS_3934419561",
      mpName: "赛博禅心",
    });
    expect(preview.warning).toContain("当前文章");
  });

  it("can subscribe from validated MP metadata without resolving the article again", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input);
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/wx/mps") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          mp_name: "赛博禅心",
          mp_id: "MzkzNDQxOTU2MQ==",
        });
        return response({
          code: 0,
          data: {
            id: "MP_WXS_3934419561",
            mp_name: "赛博禅心",
            faker_id: "MzkzNDQxOTU2MQ==",
          },
        });
      }
      return response({}, 404);
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    const feed = await connector.subscribeResolved({
      mpId: "MP_WXS_3934419561",
      mpName: "赛博禅心",
      mpBiz: "MzkzNDQxOTU2MQ==",
    });

    expect(feed.mpName).toBe("赛博禅心");
    expect(paths).toEqual(["/api/v1/wx/mps"]);
  });

  it("unsubscribes a WeRSS MP by id", async () => {
    const requests: Array<{ pathname: string; method?: string }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input);
      requests.push({ pathname: url.pathname, method: init?.method });
      return response({ code: 0, message: "success", data: {} });
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    await connector.unsubscribe("MP_WXS_3934419561");

    expect(requests).toEqual([{ pathname: "/api/v1/wx/mps/MP_WXS_3934419561", method: "DELETE" }]);
  });

  it("collects the resolved article when the MP article list is still empty", async () => {
    const fetcher = (async (input: string | URL) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        return response({
          code: 0,
          data: {
            id: "single-article",
            title: "刚识别出来的新公众号文章",
            description: "摘要",
            content: "<p>正文</p>",
            publish_time: 1_784_015_460,
            mp_id: "MP_NEW",
            mp_info: { mp_name: "新公众号", biz: "BIZ_NEW" },
          },
        });
      }
      if (url.pathname === "/api/v1/wx/articles") {
        return response({ code: 0, data: { list: [], total: 0 } });
      }
      return response({ code: 0, data: { list: [], total: 0 } });
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    const result = await connector.collect({
      provider: "werss",
      articleUrl: "https://mp.weixin.qq.com/s/single-article",
    });

    expect(result.cursor).toMatchObject({ mpId: "MP_NEW", mpName: "新公众号", mpBiz: "BIZ_NEW" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].authorName).toBe("新公众号");
    expect(result.items[0].title).toBe("刚识别出来的新公众号文章");
  });

  it("uses mpId from config during collection without resolving the article again", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const url = input instanceof URL ? input : new URL(input);
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/wx/mps/by_article") {
        throw new Error("should not resolve article when config already has mpId");
      }
      if (url.pathname === "/api/v1/wx/articles") {
        expect(url.searchParams.get("mp_id")).toBe("MP_CACHED");
        return response({
          code: 0,
          data: {
            list: [
              {
                id: "a1",
                title: "已订阅公众号的新文章",
                description: "摘要",
                publish_time: 1_784_015_460,
                mp_id: "MP_CACHED",
                mp_name: "缓存公众号",
              },
            ],
            total: 1,
          },
        });
      }
      return response({ code: 0, data: { list: [], total: 0 } });
    }) as typeof fetch;

    const connector = new WeRssConnector("http://werss:8001", "key:secret", fetcher);
    const result = await connector.collect({
      provider: "werss",
      articleUrl: "https://mp.weixin.qq.com/s/cached",
      mpId: "MP_CACHED",
      mpName: "缓存公众号",
      mpBiz: "BIZ_CACHED",
    });

    expect(result.cursor).toEqual({ mpId: "MP_CACHED" });
    expect(result.items[0].title).toBe("已订阅公众号的新文章");
    expect(paths).toEqual(["/api/v1/wx/articles"]);
  });

  it("uses the public article page when WeRSS returns no full text", async () => {
    const articleUrl = "https://mp.weixin.qq.com/s/direct-fallback";
    const fetcher = (async (input: string | URL) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.hostname === "werss") {
        return response({ code: 0, data: { title: "只有标题，没有正文" } });
      }
      if (url.toString() === articleUrl) {
        return new Response(
          '<html><body><div id="js_content"><p>这是一段足够长的微信公众号正文，用来验证公开文章直连可以接替主通道。</p></div></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return response({}, 404);
    }) as typeof fetch;

    const connector = new WeRssConnector(
      "http://werss:8001",
      "key:secret",
      fetcher,
      { directFallbackEnabled: true },
    );
    const result = await connector.fetchFullTextResult(articleUrl);

    expect(result.status).toBe("success");
    expect(result.provider).toBe("direct");
    expect(result.html).toContain("公开文章直连");
  });
});
