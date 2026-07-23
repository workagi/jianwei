/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it } from "vitest";
import { XaiSearchConnector } from "@/connectors/x/xai-search-connector";

function mockResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Type-safe fetch mock that ignores inputs and returns a cloned response each call. */
function mockFetch(response: Response): typeof fetch {
  return ((_url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(response.clone())) as typeof fetch;
}

describe("XaiSearchConnector", () => {
  it("ingests only citation-backed posts from the requested account", async () => {
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      mockFetch(mockResponse({
        output_text: JSON.stringify({
          profile_name: "OpenAI",
          posts: [
            { url: "https://x.com/OpenAI/status/123", text: "verified post", post_type: "original", published_at: "2026-07-15T10:00:00Z" },
            { url: "https://x.com/OpenAI/status/999", text: "uncited post", post_type: "original", published_at: "2026-07-15T09:00:00Z" },
          ],
        }),
        citations: [{ url: "https://x.com/OpenAI/status/123" }],
      })),
    );

    const preview = await connector.validate({ provider: "x_grok", username: "OpenAI", includeReplies: false, includeReposts: false, includeQuotes: false });
    expect(preview.items).toHaveLength(1);
    expect(preview.displayName).toBe("OpenAI");
    expect(preview.items[0].upstreamId).toBe("123");
    expect(preview.items[0].text).toBe("verified post");
  });

  it("rejects synthesized answers when xAI returns no citations", async () => {
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      mockFetch(mockResponse({
        output_text: JSON.stringify({ posts: [{ url: "https://x.com/OpenAI/status/123", text: "invented" }] }),
      })),
    );

    const preview = await connector.validate({ provider: "x_grok", username: "OpenAI", includeReplies: false, includeReposts: false, includeQuotes: false });
    expect(preview.items).toHaveLength(0);
    expect(preview.warning).toContain("不入库");
  });

  it("enforces reply, repost, and quote scope after X Search returns results", async () => {
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      mockFetch(mockResponse({
        output_text: JSON.stringify({
          profile_name: "OpenAI",
          posts: [
            { url: "https://x.com/OpenAI/status/101", text: "top-level post", post_type: "original" },
            { url: "https://x.com/OpenAI/status/102", text: "a reply", post_type: "reply" },
            { url: "https://x.com/OpenAI/status/103", text: "a native repost", post_type: "repost" },
            {
              url: "https://x.com/OpenAI/status/104",
              text: "commentary on a quoted post",
              post_type: "quote",
              quoted_text: "the nested quoted post",
              quoted_author_name: "Arena.ai",
              quoted_author_handle: "arena_ai",
              quoted_url: "https://x.com/arena_ai/status/200",
            },
            { url: "https://x.com/OpenAI/status/105", text: "uncertain type" },
          ],
        }),
        citations: [101, 102, 103, 104, 105].map((id) => ({ url: `https://x.com/OpenAI/status/${id}` })),
      })),
    );

    const originalsOnly = await connector.validate({
      provider: "x_grok", username: "OpenAI",
      includeReplies: false, includeReposts: false, includeQuotes: false,
    });
    expect(originalsOnly.items.map((item) => item.upstreamId)).toEqual(["101"]);

    const withQuotes = await connector.validate({
      provider: "x_grok", username: "OpenAI",
      includeReplies: false, includeReposts: false, includeQuotes: true,
    });
    expect(withQuotes.items.map((item) => item.upstreamId)).toEqual(["101", "104"]);
    expect(withQuotes.items[1].quotedPost).toMatchObject({
      text: "the nested quoted post",
      authorName: "Arena.ai",
      authorHandle: "arena_ai",
    });
    expect(withQuotes.items[1].contentHtml).toContain("x_quote");
  });

  it("retries transient xAI failures before giving up", async () => {
    let attempts = 0;
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      ((async (_url: RequestInfo | URL, _init?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) return new Response("temporarily unavailable", { status: 503 });
        return mockResponse({
          output_text: JSON.stringify({ posts: [{ url: "https://x.com/OpenAI/status/106", text: "recovered", post_type: "original" }] }),
          citations: [{ url: "https://x.com/OpenAI/status/106" }],
        });
      }) as typeof fetch),
    );

    const preview = await connector.validate({ provider: "x_grok", username: "OpenAI", includeReplies: false, includeReposts: false, includeQuotes: false });
    expect(attempts).toBe(2);
    expect(preview.items[0].text).toBe("recovered");
  });

  it("retries network failures that throw before a response exists", async () => {
    let attempts = 0;
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      ((async (_url: RequestInfo | URL, _init?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
        return mockResponse({
          output_text: JSON.stringify({ posts: [{ url: "https://x.com/OpenAI/status/107", text: "network recovered", post_type: "original" }] }),
          citations: [{ url: "https://x.com/OpenAI/status/107" }],
        });
      }) as typeof fetch),
    );

    const preview = await connector.validate({ provider: "x_grok", username: "OpenAI", includeReplies: false, includeReposts: false, includeQuotes: false });
    expect(attempts).toBe(2);
    expect(preview.items[0].text).toBe("network recovered");
  });

  it("accepts xAI's citation-backed numbered prose fallback", async () => {
    const connector = new XaiSearchConnector(
      async () => "oauth-token",
      mockFetch(mockResponse({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: '**1. Exact post:** "hello from X"  \n**Type:** original  \n**URL:** https://x.com/OpenAI/status/2077512758648885355',
            annotations: [{ type: "url_citation", url: "https://x.com/OpenAI/status/2077512758648885355" }],
          }],
        }],
      })),
    );

    const preview = await connector.validate({ provider: "x_grok", username: "OpenAI", includeReplies: false, includeReposts: false, includeQuotes: false });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].text).toBe("hello from X");
    expect(preview.items[0].publishedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
