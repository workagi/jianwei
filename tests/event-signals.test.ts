import { describe, expect, it } from "vitest";
import { parseEventSignal, type EventSignal } from "@/lib/event-signals";
import { developmentInputs, selectFreshDevelopments } from "@/lib/event-changes";
import { isLikelySameEvent, type ClusterableReaderItem } from "@/lib/content-clustering";
import { planEventAssignments } from "@/lib/event-projection";
import { parseAnalysisResponse } from "@/lib/summarizer";

function signal(overrides: Partial<EventSignal> = {}): EventSignal {
  return { subject: "Acme", action: "release", object: "Agent", version: "2.0", occurredOn: "2026-10-02", stage: "available",
    evidence: "Acme 发布 Agent 2.0。", facts: [], ...overrides };
}
function article(id: string, title: string, eventSignal: EventSignal): ClusterableReaderItem {
  return { id, title, source: "同一媒体", platform: "web_search", date: "2026-10-02T09:00:00Z", excerpt: "", tags: [], score: 80, whyKept: "", eventSignal };
}
describe("source-backed event signals", () => {
  it("rejects explicit contradictions and invented numeric facts at the existing parse boundary", () => {
    expect(parseEventSignal(signal({ evidence: "Acme Agent is not available yet." }), "Acme Agent is not available yet.")).toBeUndefined();
    const source = "Acme 发布 Agent 2.0。月费为30美元，最多1,000次调用。";
    expect(parseEventSignal(signal({ facts: [
      { aspect: "price", value: "USD0/month", evidence: "月费为30美元" },
      { aspect: "metric", value: "1000 calls", evidence: "最多1,000次调用。" },
    ] }), source)?.facts.map(fact => fact.value)).toEqual(["1000 calls"]);
  });
  it("recognizes dated availability reopening in the same story, including products without a numbered version", () => {
    const first = article("a", "Acme 服务开放", signal({ action: "availability", version: null, occurredOn: "2026-10-01" }));
    first.date = "2026-10-01T09:00:00Z";
    const resumed = article("b", "Acme 服务重新开放", signal({ action: "availability", version: null, occurredOn: "2026-10-03" }));
    resumed.date = "2026-10-03T09:00:00Z";
    expect(isLikelySameEvent(first, resumed)).toBe(false);
    expect(planEventAssignments([{ ...first, eventId: "stable" }, resumed])[0].eventId).toBe("stable");
  });
  it("notifies reopening but keeps same-state confirmations and older availability reports silent", () => {
    const history = [
      { developmentKey: "availability:available:2026-10-01", eventRevision: 1 },
      { developmentKey: "availability:restricted:2026-10-02", eventRevision: 2 },
    ];
    const input = { itemId: "a", sourceRevision: 1, projectedRevision: 0, title: "可用性说明", bodyText: "原文" };
    const reopened = developmentInputs({ ...input, eventSignal: signal({ action: "availability", occurredOn: "2026-10-03" }) });
    expect(selectFreshDevelopments(reopened, history)[0].notify).toBe(true);
    history.push({ developmentKey: reopened[0].developmentKey, eventRevision: 3 });
    expect(selectFreshDevelopments(reopened, history)).toEqual([]);
    const confirmed = developmentInputs({ ...input, eventSignal: signal({ action: "availability", occurredOn: "2026-10-04" }) });
    expect(selectFreshDevelopments(confirmed, history)[0].notify).toBe(false);
    history.push({ developmentKey: confirmed[0].developmentKey, eventRevision: 0 });
    const old = developmentInputs({ ...input, eventSignal: signal({ action: "availability", occurredOn: "2026-10-01", stage: "restricted" }) });
    expect(selectFreshDevelopments(old, history)[0].notify).toBe(false);
  });
  it("retains only verbatim evidence without discarding a usable summary", () => {
    const event = signal({ facts: [{ aspect: "price", value: "USD20/month", evidence: "每月收费20美元。" },
      { aspect: "access", value: "all users", evidence: "所有用户都已获得权限。" }] });
    const source = "Acme 发布 Agent 2.0。每月收费20美元。";
    expect(parseEventSignal(event, source)?.facts).toHaveLength(1);
    const response = JSON.stringify({ summary: "Acme 发布 Agent 2.0，并公布了月费和接口使用说明。", event });
    expect(parseAnalysisResponse(response, source).eventSignal?.facts[0].value).toBe("USD20/month");
    expect(parseAnalysisResponse(response, "无对应原文").summary).toContain("Agent");
    expect(parseAnalysisResponse(response, "无对应原文").eventSignal).toBeUndefined();
    expect(parseEventSignal({ ...event, occurredOn: "2026-02-30" }, source)).toBeUndefined();
  });
  it("groups translated or same-publisher reports through explicit event identity", () => {
    const a = article("a", "Acme 发布 Agent 2.0", signal());
    const b = article("b", "Acme launches Agent 2.0", signal({ subject: "ACME", evidence: "Acme launches Agent 2.0" }));
    expect(isLikelySameEvent(a, b)).toBe(true);
    expect(new Set(planEventAssignments([a, b]).map(row => row.eventId)).size).toBe(1);
    expect(planEventAssignments([{ ...a, eventId: "stable" }, b])[0].eventId).toBe("stable");
  });
  it("keeps separate occurrences and objects separate even when headlines are identical", () => {
    const a = article("a", "Acme 推出产品更新", signal({ object: "Autumn update", version: null }));
    expect(isLikelySameEvent(a, { ...a, id: "b", eventSignal: signal({ object: "Winter update", version: null }) })).toBe(false);
    const c = article("c", "Acme 发布 Agent 2.0", signal());
    expect(isLikelySameEvent(c, { ...c, id: "d", eventSignal: signal({ occurredOn: "2026-10-01" }) })).toBe(false);
    expect(planEventAssignments([{ ...c, eventId: "stable" }, { ...c, id: "d", eventSignal: signal({ occurredOn: "2026-10-01" }) }])[0].eventId).not.toBe("stable");
  });
  it("keeps a denial out of the same occurrence and attaches explicit version progress", () => {
    const a = article("a", "Acme 发布 Agent 2.0", signal());
    const b = article("b", "Acme withdraws Agent 2.0", signal({ stage: "restricted", occurredOn: "2026-10-05" }));
    b.date = "2026-10-05T09:00:00Z";
    expect(isLikelySameEvent(a, b)).toBe(false);
    expect(planEventAssignments([{ ...a, eventId: "stable" }, b])[0].eventId).toBe("stable");
    expect(planEventAssignments([{ ...a, eventId: "stable" }, { ...b, eventSignal: signal({ stage: "restricted", version: "3.0" }) }])[0].eventId).not.toBe("stable");
  });
  it("deduplicates fact values across reports while exposing different same-stage facts", () => {
    const input = { itemId: "a", sourceRevision: 1, projectedRevision: 0, title: "价格说明", bodyText: "原文" };
    const price = { aspect: "price" as const, value: "USD20/month", evidence: "每月收费20美元。" };
    const first = developmentInputs({ ...input, eventSignal: signal({ facts: [price] }) });
    const repeated = developmentInputs({ ...input, itemId: "b", eventSignal: signal({ facts: [{ ...price, value: "USD20/month", evidence: "The price is USD20/month." }] }) });
    expect(first.map(d => d.developmentKey)).toEqual(repeated.map(d => d.developmentKey));
    const different = developmentInputs({ ...input, eventSignal: signal({ facts: [{ ...price, value: "USD30/month" }] }) });
    expect(different[1].developmentKey).not.toBe(first[1].developmentKey);
    expect(different[1].label).toContain("价格");
  });
});
