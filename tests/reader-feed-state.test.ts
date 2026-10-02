import { afterEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => vi.fn(() => Promise.reject(new Error("database unavailable"))));
vi.mock("@/db/queries", async importOriginal => ({
  ...await importOriginal<typeof import("@/db/queries")>(),
  getReaderItems: queries, getReaderEventIds: queries, countItems: queries,
}));
import { loadReaderFeed } from "@/lib/reader-data";

afterEach(() => { vi.unstubAllEnvs(); queries.mockClear(); });
describe("reader installation and runtime states", () => {
  it("keeps examples available before database configuration", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const feed = await loadReaderFeed({ mode: "latest" });
    expect(feed.usingDemo).toBe(true);
    expect(feed.unavailable).not.toBe(true);
    expect(feed.items.length).toBeGreaterThan(0);
    expect(queries).not.toHaveBeenCalled();
  });
  it.each(["changes", "featured", "latest"] as const)("shows unavailability instead of examples after a %s read failure", async mode => {
    vi.stubEnv("DATABASE_URL", "postgresql://unused/test");
    const feed = await loadReaderFeed({ mode, platform: "web_search" });
    expect(feed).toMatchObject({ usingDemo: false, unavailable: true, items: [], total: 0 });
    expect(queries).toHaveBeenCalled();
  });
});
