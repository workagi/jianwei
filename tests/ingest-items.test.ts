import { describe, it, expect } from "vitest";
import {
  commitPreparedIngest,
  documentAnalysisClaimLeaseMinutes,
  ingest,
  prepareIngest,
  safePublishedAt,
  toItemRows,
  type IngestItemRow,
  type IngestMatchLink,
  type IngestMatchObservation,
  type IngestRepository,
  type IngestSourceObservation,
  type DocumentAnalysisClaim,
} from "@/ingestion/ingest-items";
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
  sourceRows: IngestSourceObservation[] = [];
  matchLinks: IngestMatchLink[] = [];
  matchObservations: IngestMatchObservation[] = [];
  completedClaims = 0;
  releasedClaims = 0;

  async upsertItems(rows: IngestItemRow[]) {
    const returned = rows.map((r, i) => ({
      id: `id-${i}`,
      platform: r.platform as NormalizedItem["platform"],
      upstreamId: r.upstreamId,
      canonicalUrl: r.canonicalUrl,
    }));
    this.itemRows.push(...rows);
    return returned;
  }

  async upsertSourceItems(observations: IngestSourceObservation[]) {
    this.sourceRows.push(...observations);
    return observations.map((observation, index) => ({
      id: `source-${index}`,
      itemId: observation.itemId,
      platform: observation.platform,
      sourceProvider: observation.sourceProvider,
      upstreamId: observation.upstreamId,
    }));
  }

  async linkMatches(links: IngestMatchLink[]) {
    this.matchLinks.push(...links);
    return links.length;
  }

  async insertMatchObservations(observations: IngestMatchObservation[]) {
    this.matchObservations.push(...observations);
    return observations.length;
  }

  async findExistingSourceKeys(
    _unused_sources: Array<{ platform: string; sourceProvider: string; upstreamId: string }>,
  ): Promise<Set<string>> {
    void _unused_sources;
    return new Set();
  }

  async findExistingCanonicalUrls(_unused_urls: string[]): Promise<Set<string>> {
    void _unused_urls;
    return new Set();
  }

  async claimDocumentAnalysis(_unused_input: {
    canonicalUrlHash: string;
    analysisVersion: string;
    ownerWorkerId: string;
    leaseMinutes: number;
  }): Promise<DocumentAnalysisClaim | null> {
    return {
      id: "claim-1",
      canonicalUrlHash: _unused_input.canonicalUrlHash,
      analysisVersion: _unused_input.analysisVersion,
      ownerWorkerId: _unused_input.ownerWorkerId,
      claimToken: "claim-token-1",
    };
  }

  async completeDocumentAnalyses(claims: Array<{ id: string }>) {
    this.completedClaims += claims.length;
    return claims.length;
  }

  async releaseDocumentAnalyses(claims: Array<{ id: string }>) {
    this.releasedClaims += claims.length;
    return claims.length;
  }
}

describe("toItemRows", () => {
  it("uses a bounded 30-minute document-analysis claim lease by default", () => {
    expect(documentAnalysisClaimLeaseMinutes(undefined)).toBe(30);
    expect(documentAnalysisClaimLeaseMinutes("1")).toBe(5);
    expect(documentAnalysisClaimLeaseMinutes("45")).toBe(45);
    expect(documentAnalysisClaimLeaseMinutes("999")).toBe(120);
  });

  it("canonicalizes tracking params and dedupes by upstream id", () => {
    const rows = toItemRows([makeItem(), makeItem()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalUrl).toBe("https://x.com/a");
    expect(rows[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never persists an unsafe external URL scheme as a clickable canonical URL", () => {
    const unsafe = toItemRows([makeItem({
      upstreamId: "unsafe/id",
      canonicalUrl: "javascript:alert(document.cookie)",
    })]);
    const malformed = toItemRows([makeItem({
      upstreamId: "malformed id",
      canonicalUrl: "not a valid url",
    })]);

    expect(unsafe[0].canonicalUrl).toBe("signaldeck:orphan:x:unsafe%2Fid");
    expect(malformed[0].canonicalUrl).toBe("signaldeck:orphan:x:malformed%20id");
  });

  it("keeps distinct upstream ids", () => {
    const rows = toItemRows([makeItem(), makeItem({ upstreamId: "u2", canonicalUrl: "https://x.com/b" })]);
    expect(rows).toHaveLength(2);
  });

  it("collapses different upstream ids that share one canonical URL", () => {
    const rows = toItemRows([
      makeItem({
        platform: "wechat",
        upstreamId: "2392024520-2651097629_1",
        canonicalUrl: "https://mp.weixin.qq.com/s/znF4CNSMGPNxJ9CZuH04JQ",
      }),
      makeItem({
        platform: "wechat",
        upstreamId: "znF4CNSMGPNxJ9CZuH04JQ",
        canonicalUrl: "https://mp.weixin.qq.com/s/znF4CNSMGPNxJ9CZuH04JQ?utm_source=x",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalUrl).toBe("https://mp.weixin.qq.com/s/znF4CNSMGPNxJ9CZuH04JQ");
  });

  it("keeps the richest representation when duplicate canonical URLs share a batch", () => {
    const rows = toItemRows([
      makeItem({
        upstreamId: "short",
        canonicalUrl: "https://example.com/quality",
        title: undefined,
        text: "摘要",
      }),
      makeItem({
        upstreamId: "full",
        canonicalUrl: "https://example.com/quality?utm_source=rss",
        title: "完整文章标题",
        text: "这是一段明显更完整的文章正文，包含事实、背景和结论。",
        contentHtml: "<article><p>完整正文</p><p>第二段事实</p></article>",
        contentFetchStatus: "success",
        imageUrls: ["https://example.com/cover.jpg"],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      upstreamId: "full",
      title: "完整文章标题",
      contentFetchStatus: "success",
      imageUrls: ["https://example.com/cover.jpg"],
    });
    expect(rows[0].bodyText).toContain("更完整");
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
    expect(rows[0].retentionReason).toBeNull();
    // retentionSource moved to item_matches; items only carries informationValueScore
    expect(rows[0].retentionSource).toBeUndefined();
    expect(rows[0].informationValueScore).toBeGreaterThanOrEqual(50);
  });

  it("persists WeChat full-text provenance separately from the article body", () => {
    const fetchedAt = new Date("2026-07-15T08:00:00Z");
    const rows = toItemRows([
      makeItem({
        platform: "wechat",
        contentHtml: "<p>公众号完整正文内容，已经由备用通道成功补回。</p>",
        contentProvider: "direct",
        contentFetchStatus: "success",
        contentFetchedAt: fetchedAt,
      }),
    ]);

    expect(rows[0]).toMatchObject({
      contentProvider: "direct",
      contentFetchStatus: "success",
      contentFetchError: null,
      contentFetchedAt: fetchedAt,
    });
  });

  it("persists the source provider independently from the broad platform", () => {
    const rows = toItemRows([
      makeItem({
        platform: "web_search",
        sourceProvider: "web_tavily",
        upstreamId: "tavily-1",
        canonicalUrl: "https://example.com/tavily",
      }),
    ]);

    expect(rows[0].platform).toBe("web_search");
    expect(rows[0].sourceProvider).toBe("web_tavily");
  });

  it("persists an X profile avatar independently from post media", () => {
    const rows = toItemRows([makeItem({ avatarUrl: "https://pbs.twimg.com/profile_images/example.jpg" })]);
    expect(rows[0].avatarUrl).toBe("https://pbs.twimg.com/profile_images/example.jpg");
  });
});

describe("ingest", () => {
  it("does not write until a prepared batch is explicitly committed", async () => {
    const repo = new MemRepo();
    const prepared = await prepareIngest(repo, { items: [makeItem()], monitorId: "m1" });

    expect(repo.itemRows).toHaveLength(0);
    expect(repo.matchLinks).toHaveLength(0);

    const result = await commitPreparedIngest(repo, prepared);
    expect(result.itemsUpserted).toBe(1);
    expect(repo.itemRows).toHaveLength(1);
    expect(repo.sourceRows).toHaveLength(1);
    expect(repo.matchLinks).toHaveLength(1);
    expect(repo.matchObservations).toHaveLength(1);
    expect(repo.completedClaims).toBe(1);
  });

  it("upserts items and links them to the monitor", async () => {
    const repo = new MemRepo();
    const result = await ingest(repo, {
      items: [makeItem(), makeItem({ upstreamId: "u2", canonicalUrl: "https://x.com/b" })],
      monitorId: "m1",
    });
    expect(result.itemsUpserted).toBe(2);
    expect(result.matchesInserted).toBe(2);
    expect(result.summary.status).toBe("disabled");
    expect(repo.itemRows.every((row) => row.analysisStatus === "disabled")).toBe(true);
    expect(repo.sourceRows).toHaveLength(2);
    expect(repo.matchLinks.every((m) => m.monitorId === "m1")).toBe(true);
    expect(repo.matchLinks.every((m) => Boolean(m.sourceItemId))).toBe(true);
    expect(repo.matchLinks.every((m) => m.retentionStatus === "kept")).toBe(true);
    expect(repo.matchObservations).toHaveLength(2);
    expect(repo.completedClaims).toBe(2);
  });

  it("routes the canonical quality winner instead of an earlier short duplicate", async () => {
    const repo = new MemRepo();
    await ingest(repo, {
      monitorId: "m1",
      items: [
        makeItem({
          upstreamId: "short-first",
          canonicalUrl: "https://example.com/routed-quality",
          title: undefined,
          text: "摘要",
        }),
        makeItem({
          upstreamId: "full-second",
          canonicalUrl: "https://example.com/routed-quality?utm_source=rss",
          title: "完整文章标题",
          text: "这是应该进入分析路由的完整正文，包含足够多的事实细节。",
          contentHtml: "<article><p>完整正文</p><p>事实细节</p></article>",
          contentFetchStatus: "success",
        }),
      ],
    });

    expect(repo.itemRows).toHaveLength(1);
    expect(repo.itemRows[0]).toMatchObject({
      upstreamId: "full-second",
      analysisStatus: "disabled",
    });
    expect(repo.completedClaims).toBe(1);
  });

  it("fails closed when the document-analysis claim store is unavailable", async () => {
    class FailingClaimRepo extends MemRepo {
      async claimDocumentAnalysis(): Promise<never> {
        throw new Error("claim database unavailable");
      }
    }
    const repo = new FailingClaimRepo();

    await expect(prepareIngest(repo, {
      items: [makeItem()],
      monitorId: "m1",
    })).rejects.toThrow("claim database unavailable");
    expect(repo.itemRows).toHaveLength(0);
    expect(repo.completedClaims).toBe(0);
  });

  it("releases partial batch claims and retries when another owner is analyzing a document", async () => {
    class ContendedClaimRepo extends MemRepo {
      claimCalls = 0;
      async claimDocumentAnalysis(input: {
        canonicalUrlHash: string;
        analysisVersion: string;
        ownerWorkerId: string;
      }) {
        this.claimCalls += 1;
        if (this.claimCalls === 2) return null;
        return {
          id: "claim-owned",
          canonicalUrlHash: input.canonicalUrlHash,
          analysisVersion: input.analysisVersion,
          ownerWorkerId: input.ownerWorkerId,
          claimToken: "claim-token-owned",
        };
      }
    }
    const repo = new ContendedClaimRepo();

    await expect(prepareIngest(repo, {
      monitorId: "m1",
      items: [
        makeItem({ upstreamId: "claim-a", canonicalUrl: "https://example.com/claim-a" }),
        makeItem({ upstreamId: "claim-b", canonicalUrl: "https://example.com/claim-b" }),
      ],
    })).rejects.toThrow("DOCUMENT_ANALYSIS_IN_PROGRESS");
    expect(repo.releasedClaims).toBe(1);
    expect(repo.itemRows).toHaveLength(0);
  });

  it("stores hard Gate rejections as audit-only matches", async () => {
    const repo = new MemRepo();
    await ingest(repo, {
      items: [makeItem({ title: "招聘：AI 工程师", text: "加入我们负责 AI 产品开发" })],
      monitorId: "m1",
      monitorRules: {
        keywords: ["AI"],
        requiredKeywords: [],
        excludeKeywords: ["招聘"],
      },
    });

    expect(repo.matchLinks).toHaveLength(1);
    expect(repo.matchLinks[0].retentionStatus).toBe("gate_blocked");
    expect(repo.matchLinks[0].relevanceScore).toBe(-1);
  });

  it("evaluates monitor rules against the persisted canonical analysis", async () => {
    class CanonicalDocumentRepo extends MemRepo {
      override async upsertItems(rows: IngestItemRow[]) {
        this.itemRows.push(...rows);
        return [{
          id: "canonical-document",
          platform: rows[0].platform as NormalizedItem["platform"],
          upstreamId: rows[0].upstreamId,
          canonicalUrl: rows[0].canonicalUrl,
          title: "OpenAI model release",
          bodyText: "OpenAI released a new model with verified details.",
          aiSummary: "Canonical model analysis",
          contentType: "model_release",
          topicTags: ["OpenAI"],
          informationValueScore: 93,
          analysisStatus: "success",
          analysisVersion: "v2",
        }];
      }
    }
    const repo = new CanonicalDocumentRepo();

    await commitPreparedIngest(repo, {
      input: {
        items: [makeItem({ title: "Unrelated snippet", text: "unrelated" })],
        monitorId: "m1",
        monitorRules: {
          keywords: [],
          requiredKeywords: ["OpenAI"],
          excludeKeywords: [],
        },
      },
      rows: [toItemRows([makeItem({ title: "Unrelated snippet", text: "unrelated" })])[0]],
      summary: { status: "not_applicable", attempted: 0, succeeded: 0, failed: 0 },
      analysisClaims: [],
    });

    expect(repo.matchLinks[0]).toMatchObject({
      retentionStatus: "kept",
      analysisStatus: "success",
      analysisVersion: "v2",
    });
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

  it("keeps distinct source observations when providers discover one document", async () => {
    const repo = new MemRepo();
    await ingest(repo, {
      items: [
        makeItem({
          platform: "web_search",
          sourceProvider: "web_brave",
          upstreamId: "brave-1",
          canonicalUrl: "https://example.com/shared-article",
        }),
        makeItem({
          platform: "trendradar",
          sourceProvider: "trendradar",
          upstreamId: "rss-1",
          canonicalUrl: "https://example.com/shared-article?utm_source=rss",
        }),
      ],
      monitorId: "m1",
    });

    expect(repo.itemRows).toHaveLength(1);
    expect(repo.sourceRows).toHaveLength(2);
    expect(repo.sourceRows.map((source) => source.sourceProvider)).toEqual([
      "web_brave",
      "trendradar",
    ]);
    expect(repo.matchLinks).toHaveLength(1);
    expect(repo.matchObservations).toHaveLength(2);
  });

  it("treats the same upstream id on another platform as a new item", async () => {
    class CrossPlatformRepo extends MemRepo {
      async findExistingSourceKeys() {
        return new Set(["x|x|shared-id"]);
      }
    }
    const repo = new CrossPlatformRepo();
    await ingest(repo, {
      items: [makeItem({
        platform: "trendradar",
        upstreamId: "shared-id",
        canonicalUrl: "https://example.com/from-trendradar",
      })],
      monitorId: "m1",
    });

    expect(repo.itemRows[0].analysisStatus).toBe("disabled");
  });

  it("treats the same upstream id from another provider as a new source", async () => {
    class CrossProviderRepo extends MemRepo {
      async findExistingSourceKeys() {
        return new Set(["web_search|web_brave|shared-id"]);
      }
    }
    const repo = new CrossProviderRepo();
    await ingest(repo, {
      items: [makeItem({
        platform: "web_search",
        sourceProvider: "web_tavily",
        upstreamId: "shared-id",
        canonicalUrl: "https://example.com/from-tavily",
      })],
      monitorId: "m1",
    });

    expect(repo.itemRows[0].analysisStatus).toBe("disabled");
    expect(repo.sourceRows[0].sourceProvider).toBe("web_tavily");
  });
});
