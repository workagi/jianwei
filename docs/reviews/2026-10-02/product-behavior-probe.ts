/** Read-only audit probe: synthetic inputs, no DB, network or model calls.
 * Run from the repository root:
 * node --import tsx docs/reviews/2026-10-02/product-behavior-probe.ts
 */
import {
  buildFeaturedFeed, eventTitleSimilarity, featuredEventRank,
  groupPersistedEvents, isLikelySameEvent, selectTopFeaturedEvents,
} from "../../../src/lib/content-clustering";
import { deriveMonitorRetention } from "../../../src/lib/content-retention";

const now = Date.parse("2026-10-02T12:00:00Z");
function item(id: string, score = 60, minutes = 0, source = id, eventId = id) {
  return {
    id, score, source, eventId, platform: "web_search" as const,
    title: `某产品发布了新的可用功能 ${id}`,
    excerpt: "该产品提供了新的工具入口、详细使用说明和可核对的参数信息。",
    whyKept: "该产品开放新的工具调用能力，改变现有工作流程中的配置方法。",
    date: new Date(now - minutes * 60_000).toISOString(),
    tags: ["工具", "Agent"], url: `https://example.test/${id}`, bookmarked: false,
  };
}

const all = Array.from({ length: 37 }, (_, i) => item(`event-${i}`, i === 36 ? 100 : 60, i));
const visible = buildFeaturedFeed(all, { persisted: true });
const samePublisher = Array.from({ length: 6 }, (_, i) => item(`publisher-${i}`, i === 5 ? 100 : 60, i, "同一发布方"));
const capped = buildFeaturedFeed(samePublisher, { persisted: true, balancePlatforms: true });

const newer = { ...item("newer", 70, 1, "媒体", "shared-event"), bookmarked: true };
const older = item("older", 90, 60, "官方", "shared-event");
const describe = (x: typeof newer) => ({ id: x.id, eventId: x.eventId, date: x.date, bookmarked: x.bookmarked });

const open = { ...item("open", 70, 0, "来源甲"), title: "Acme Agent 2.0 宣布向所有用户免费开放 API" };
const closed = { ...item("closed", 90, 1, "来源乙"), title: "Acme Agent 2.0 宣布不向所有用户免费开放 API" };
const syndicated = {
  ...item("syndicated", 70),
  relatedSources: Array.from({ length: 4 }, (_, i) => ({ platform: "web_search" as const, source: `转述来源-${i}`, title: "相同报道" })),
};
const single = { ...item("single", 92), relatedSources: [] };
const monitor = deriveMonitorRetention({ keywords: ["MCP"], contentTypeFilters: ["tutorial"], topicFilters: ["MCP", "Agent"] }, {
  title: "MCP 配置", bodyText: "MCP 接口教程", contentType: "tutorial", topicTags: ["MCP", "Agent"], informationValueScore: 45,
});

console.log(JSON.stringify({
  scope: "Synthetic pure-function probes; not production accuracy or database integration tests.",
  topCandidateTruncation: {
    population: all.length, visible: visible.length,
    fullPopulationTop: selectTopFeaturedEvents(all, { now, limit: 1 })[0].id,
    renderedTop: selectTopFeaturedEvents(visible, { now, limit: 1 })[0].id,
    highestScoreVisible: visible.some(x => x.score === 100),
  },
  publisherQuotaBeforeUtility: {
    population: samePublisher.length, visible: capped.length,
    highestScoreVisible: capped.some(x => x.score === 100),
  },
  representativeSwap: {
    before: describe(groupPersistedEvents([newer])[0]),
    after: describe(groupPersistedEvents([newer, older])[0]),
  },
  oppositeActions: {
    titles: [open.title, closed.title],
    similarity: eventTitleSimilarity(open.title, closed.title),
    mergedByCurrentRule: isLikelySameEvent(open, closed),
  },
  coverageBoost: {
    score70WithFourReports: featuredEventRank(syndicated, now),
    score92WithNoOtherReport: featuredEventRank(single, now),
    selectedTop: selectTopFeaturedEvents([syndicated, single], { now, limit: 1 })[0].id,
    note: "The current input type cannot express whether these publishers cite the same primary evidence.",
  },
  monitorVsDocumentValue: {
    documentInformationValue: 45, monitor,
    note: "Separately inspected SQL in src/db/queries.ts requires documentInformationValue >= 60 for featuredOnly, including monitor-filtered views; this probe does not execute that SQL.",
  },
}, null, 2));
