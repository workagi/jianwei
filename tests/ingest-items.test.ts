import { describe, it, expect } from "vitest";
import { safePublishedAt, toItemRows, ingest, type IngestRepository, type IngestItemRow } from "@/ingestion/ingest-items";
import type { NormalizedItem } from "@/connectors/types";

function makeItem(over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    platform: "x",
    upstreamId: "u1",
    canonicalUrl: "https://x.com/a?utm_source=tw&ref=home",
    title: "T",
    text: "body text",
    imageUrls: [],
    publishedAt: new Date("2026-07-08T10:00:00Z"),
    authorHandle: "h",
    raw: {},
    ...over,
  };
}

class MemRepo implements IngestRepository {
  itemRows: IngestItemRow[] = [];
  matchLinks: Array<{ itemId: string; monitorId: string }> = [];

  async upsertItems(rows: IngestItemRow[]) {
    const returned = rows.map((r, i) => ({
      id: `id-${i}`,
      platform: r.platform as NormalizedItem["platform"],
      upstreamId: r.upstreamId,
    }));
    this.itemRows.push(...rows);
    return returned;
  }

  async linkMatches(links: { itemId: string; monitorId: string }[]) {
    this.matchLinks.push(...links);
    return links.length;
  }
}

describe("toItemRows", () => {
  it("canonicalizes tracking params and dedupes by upstream id", () => {
    const rows = toItemRows([makeItem(), makeItem()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalUrl).toBe("https://x.com/a");
    expect(rows[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps distinct upstream ids", () => {
    const rows = toItemRows([makeItem(), makeItem({ upstreamId: "u2", canonicalUrl: "https://x.com/b" })]);
    expect(rows).toHaveLength(2);
  });

  it("passes trendradar platform through unchanged", () => {
    const rows = toItemRows([makeItem({ platform: "trendradar", upstreamId: "tr1" })]);
    expect(rows[0].platform).toBe("trendradar");
  });

  it("clamps clearly future publishedAt values to the ingest time", () => {
    const now = new Date("2026-07-14T12:00:00Z");
    const future = new Date("2026-07-15T12:00:00Z");
    expect(safePublishedAt(future, now)).toBe(now);
  });

  it("nulls out missing optional fields", () => {
    const rows = toItemRows([makeItem({ authorHandle: undefined, title: undefined })]);
    expect(rows[0].authorHandle).toBeNull();
    expect(rows[0].title).toBeNull();
  });

  it("adds local content classification before persistence", () => {
    const rows = toItemRows([
      makeItem({
        title: "AI Agent 工作流实践教程",
        text: "这是一篇关于 MCP、Prompt 和智能体自动化的教程。",
      }),
    ]);

    expect(rows[0].contentType).toBe("tutorial");
    expect(rows[0].topicTags).toEqual(expect.arrayContaining(["Agent", "MCP", "Prompt"]));
  });
});

describe("ingest", () => {
  it("upserts items and links them to the monitor", async () => {
    const repo = new MemRepo();
    const result = await ingest(repo, {
      items: [makeItem(), makeItem({ upstreamId: "u2", canonicalUrl: "https://x.com/b" })],
      monitorId: "m1",
    });
    expect(result.itemsUpserted).toBe(2);
    expect(result.matchesInserted).toBe(2);
    expect(result.summary.status).toBe("disabled");
    expect(repo.matchLinks.every((m) => m.monitorId === "m1")).toBe(true);
  });

  it("returns zeros for an empty batch", async () => {
    const repo = new MemRepo();
    const result = await ingest(repo, { items: [], monitorId: "m1" });
    expect(result).toEqual({
      itemsUpserted: 0,
      matchesInserted: 0,
      summary: { status: "not_applicable", attempted: 0, succeeded: 0, failed: 0 },
    });
  });

  it("collapses intra-batch duplicates before persisting", async () => {
    const repo = new MemRepo();
    await ingest(repo, { items: [makeItem(), makeItem()], monitorId: "m1" });
    expect(repo.itemRows).toHaveLength(1);
  });
});
