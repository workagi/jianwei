import { describe, expect, it, vi } from "vitest";
import {
  probeWechatFallback,
  testWechatFallbackArticle,
} from "@/lib/wechat-fallback-status";

describe("wechat fallback status", () => {
  it("reports a reachable authenticated collector", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/health")) {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        authenticated: true,
        loggedIn: true,
        account: "测试公众号",
        expireTime: 1_800_000_000_000,
        isExpired: false,
      }), { status: 200 });
    }) as typeof fetch;

    await expect(probeWechatFallback("http://wechat-fallback:5000", fetcher)).resolves.toMatchObject({
      configured: true,
      reachable: true,
      authenticated: true,
      account: "测试公众号",
      status: "登录正常",
    });
  });

  it("distinguishes service availability from missing authorization", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/health")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ authenticated: false, loggedIn: false }), { status: 200 }),
    ) as typeof fetch;

    await expect(probeWechatFallback("http://wechat-fallback:5000", fetcher)).resolves.toMatchObject({
      reachable: true,
      authenticated: false,
      status: "待扫码登录",
    });
  });

  it("tests a real article contract without exposing article content", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { title: "测试文章", content: "<p>这是足够长的公众号文章正文内容，用于测试采集器。</p>", plain_content: "纯文本正文内容" },
    }), { status: 200 })) as typeof fetch;

    await expect(testWechatFallbackArticle(
      "http://wechat-fallback:5000",
      "https://mp.weixin.qq.com/s/demo",
      fetcher,
    )).resolves.toEqual({ title: "测试文章", contentChars: 31, plainChars: 7 });
  });

  it("rejects non-WeChat URLs before calling the collector", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(testWechatFallbackArticle(
      "http://wechat-fallback:5000",
      "https://example.com/article",
      fetcher,
    )).rejects.toThrow("mp.weixin.qq.com");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
