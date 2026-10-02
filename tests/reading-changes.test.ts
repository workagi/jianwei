import { describe, expect, it } from "vitest";
import { decideContentMerge, documentContentHash } from "@/ingestion/content-revisions";
import { buildFeaturedSelection, groupPersistedEvents, isLikelySameEvent, type ClusterableReaderItem } from "@/lib/content-clustering";
import { canJoinEventStory, developmentInput } from "@/lib/event-changes";
import { planEventAssignments } from "@/lib/event-projection";

function article(id: string, score = 70, minutes = 0): ClusterableReaderItem {
  return { id, source: id, platform: "web_search", eventId: id, title: `Acme Agent 2.0 正式开放 API ${id}`,
    date: new Date(Date.parse("2026-10-02T12:00:00Z") - minutes * 60000).toISOString(), score,
    excerpt: "新接口开放给开发者，可在产品文档中核对使用方法和范围。", tags: ["Agent", "Acme"], whyKept: "该产品开放新的工具调用能力，改变现有工作流程中的配置方法。" };
}
describe("attention and stable event reading", () => {
  it("selects the strongest event before the 36-card cap, with a working timeline anchor", () => {
    const rows = Array.from({ length: 37 }, (_, i) => article(`e${i}`, i === 36 ? 100 : 60, i));
    const result = buildFeaturedSelection(rows, { persisted: true, balancePlatforms: true });
    expect(result.topItems[0].id).toBe("e36");
    expect(result.items).toHaveLength(36);
    expect(result.topItems.every(top => result.items.some(item => item.eventId === top.eventId))).toBe(true);
  });
  it("does not discard a publisher's strongest sixth event or leave room unused", () => {
    const result = buildFeaturedSelection(Array.from({ length: 6 }, (_, i) => ({ ...article(`e${i}`, i === 5 ? 100 : 60, i), source: "同一来源" })), { persisted: true, balancePlatforms: true });
    expect(result.topItems[0].score).toBe(100);
    expect(result.items).toHaveLength(6);
  });
  it("keeps event identity and the persisted activity anchor when the representative changes", () => {
    const first = { ...article("newer", 70), eventId: "stable", eventDate: "2026-10-02T12:00:00Z", eventRevision: 2, readRevision: 2, followed: true };
    const better = { ...first, id: "better", source: "another", score: 95, date: "2026-10-02T10:00:00Z" };
    const after = groupPersistedEvents([first, better])[0];
    expect(after.id).toBe("better");
    expect(after).toMatchObject({ eventId: "stable", date: first.eventDate, eventRevision: 2, readRevision: 2, followed: true });
  });
  it("keeps an opposite claim out of ordinary same-occurrence matching", () => {
    const a = { ...article("a"), title: "Acme Agent 2.0 宣布向所有用户免费开放 API" };
    const b = { ...article("b"), title: "Acme Agent 2.0 宣布不向所有用户免费开放 API" };
    expect(isLikelySameEvent(a, b)).toBe(false);
    expect(developmentInput({ itemId: "b", sourceRevision: 1, projectedRevision: 0, title: b.title, bodyText: b.title })?.label).toContain("核对");
  });
  it("attaches explicit stage progress directly to the root, without joining unrelated versions", () => {
    const root = { ...article("a"), title: "Acme Agent 2.0 计划向所有用户免费开放 API" };
    const progress = { ...article("b"), eventId: undefined, title: "Acme Agent 2.0 正式向所有用户免费开放 API", date: "2026-10-05T12:00:00Z" };
    expect(canJoinEventStory(root, progress)).toBe(true);
    expect(planEventAssignments([root, progress])[0].eventId).toBe(root.eventId);
    expect(canJoinEventStory(root, { ...progress, title: progress.title.replace("2.0", "3.0") })).toBe(false);
  });
  it("assigns repeated reports one stage key and distinguishes real revisions from hydration", () => {
    const a = developmentInput({ itemId: "a", sourceRevision: 1, projectedRevision: 0, title: article("a").title, bodyText: "原始证据" });
    const b = developmentInput({ itemId: "b", sourceRevision: 1, projectedRevision: 0, title: article("b").title, bodyText: "转述" });
    expect(a?.developmentKey).toBe(b?.developmentKey);
    expect(developmentInput({ itemId: "a", sourceRevision: 2, projectedRevision: 1, title: article("a").title, bodyText: "更正", changeKind: "source_revision" })?.developmentKey).toBe("revision:a:2");
    expect(developmentInput({ itemId: "a", sourceRevision: 2, projectedRevision: 1, title: article("a").title, bodyText: "补全", changeKind: "enrichment" })).toBeNull();
  });
});

describe("source revision versus enrichment", () => {
  const full = { platform: "wechat", sourceProvider: "wechat_werss", upstreamId: "a", title: "价格说明", bodyText: "完整价格说明：此前写成免费开放，现在确认每月收费。", contentHtml: "<p>正文</p>", contentFetchStatus: "success" };
  it("accepts a shorter correction from the complete owning source", () => {
    const next = decideContentMerge(full, { ...full, bodyText: "更正：每月收费。", contentHtml: "<p>更正</p>" });
    expect(next).toMatchObject({ changed: true, bodyWins: true, bodyText: "更正：每月收费。", kind: "source_revision" });
    expect(next.hash).not.toBe(documentContentHash(full));
  });
  it("preserves complete source text against a short search observation", () => {
    const next = decideContentMerge(full, { ...full, platform: "web_search", sourceProvider: "web_brave", upstreamId: "snippet", title: "搜索标题", bodyText: "免费开放", contentFetchStatus: null });
    expect(next).toMatchObject({ changed: false, bodyText: full.bodyText, title: full.title });
  });
  it("ignores whitespace-only changes while preserving meaningful case and negation", () => {
    expect(documentContentHash({ bodyText: "API   免费开放" })).toBe(documentContentHash({ bodyText: "API 免费开放" }));
    expect(documentContentHash({ bodyText: "API 免费开放" })).not.toBe(documentContentHash({ bodyText: "API 不免费开放" }));
  });
});
