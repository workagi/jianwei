import { afterEach, describe, expect, it, vi } from "vitest";

import { XConnector } from "@/connectors/x/x-connector";

const config = {
  provider: "x_official" as const,
  username: "OpenAI",
  includeReplies: false,
  includeReposts: false,
  includeQuotes: true,
};

afterEach(() => {
  delete process.env.X_API_MAX_PAGES;
});

describe("XConnector pagination", () => {
  it("reads every page before advancing sinceId", async () => {
    const requestedTokens: Array<string | null> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "u1", name: "OpenAI", username: "OpenAI" } }));
      }
      requestedTokens.push(url.searchParams.get("pagination_token"));
      if (!url.searchParams.has("pagination_token")) {
        return new Response(JSON.stringify({
          data: [{ id: "t3", text: "newest" }, { id: "t2", text: "middle" }],
          meta: { newest_id: "t3", next_token: "page-2" },
        }));
      }
      return new Response(JSON.stringify({
        data: [{ id: "t1", text: "oldest" }],
        meta: {},
      }));
    }) as typeof fetch;

    const result = await new XConnector("token", fetcher).collect(config, { sinceId: "t0" });

    expect(requestedTokens).toEqual([null, "page-2"]);
    expect(result.items.map((item) => item.upstreamId)).toEqual(["t3", "t2", "t1"]);
    expect(result.cursor.sinceId).toBe("t3");
  });

  it("commits fetched pages and persists a resume token at the page ceiling", async () => {
    process.env.X_API_MAX_PAGES = "1";
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "u1", name: "OpenAI", username: "OpenAI" } }));
      }
      return new Response(JSON.stringify({
        data: [{ id: "t2", text: "newest" }],
        meta: { newest_id: "t2", next_token: "page-2" },
      }));
    }) as typeof fetch;

    const result = await new XConnector("token", fetcher).collect(config, { sinceId: "t0" });
    expect(result.items.map((item) => item.upstreamId)).toEqual(["t2"]);
    expect(result.cursor).toMatchObject({
      sinceId: "t0",
      xPaginationToken: "page-2",
      xPaginationSinceId: "t0",
      xPaginationNewestId: "t2",
    });
    expect(result.billableUnits).toBe(2);
  });

  it("resumes a capped backlog and advances sinceId only after completion", async () => {
    process.env.X_API_MAX_PAGES = "1";
    const requested: Array<{ sinceId: string | null; token: string | null }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "u1", name: "OpenAI", username: "OpenAI" } }));
      }
      requested.push({
        sinceId: url.searchParams.get("since_id"),
        token: url.searchParams.get("pagination_token"),
      });
      return new Response(JSON.stringify({
        data: [{ id: "t1", text: "oldest" }],
        meta: {},
      }));
    }) as typeof fetch;

    const result = await new XConnector("token", fetcher).collect(config, {
      sinceId: "t0",
      xPaginationToken: "page-2",
      xPaginationSinceId: "t0",
      xPaginationNewestId: "t2",
    });
    expect(requested).toEqual([{ sinceId: "t0", token: "page-2" }]);
    expect(result.items.map((item) => item.upstreamId)).toEqual(["t1"]);
    expect(result.cursor).toEqual({ userId: "u1", profileName: "OpenAI", sinceId: "t2" });
  });

  it("rejects a repeated pagination token instead of looping", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "u1", name: "OpenAI", username: "OpenAI" } }));
      }
      return new Response(JSON.stringify({
        data: [{ id: "t1", text: "post" }],
        meta: { newest_id: "t1", next_token: "same-token" },
      }));
    }) as typeof fetch;

    await expect(new XConnector("token", fetcher).collect(config, {}))
      .rejects.toThrow("X_API_PAGINATION_LOOP");
  });
});
