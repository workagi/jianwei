import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateEventPairs, parseEventEvaluationCases, type EventEvaluationCase } from "@/lib/event-evaluation";

function pair(id: string, overrides: Partial<EventEvaluationCase> = {}): EventEvaluationCase {
  return {
    id, split: "development", provenance: "synthetic", expected: "same_event",
    a: { title: "OpenAI 发布 GPT-5.1 模型，提升推理能力", source: "A", platform: "web_search", date: "2026-10-02T09:00:00Z", tags: [] },
    b: { title: "OpenAI 发布 GPT-5.1 模型，提升推理能力", source: "B", platform: "x", date: "2026-10-02T10:00:00Z", tags: [] },
    ...overrides,
  };
}

describe("event quality evaluation", () => {
  it("matches actual bilingual release titles using separately identified manual signal annotations", () => {
    const data = readFileSync(new URL("./fixtures/event-pairs.observed.jsonl", import.meta.url), "utf8");
    const cases = parseEventEvaluationCases(data.trim().split("\n").map(line => JSON.parse(line)));
    const report = evaluateEventPairs(cases);
    expect(report.failures).toEqual([]);
    expect(report.scope).toBe("pairwise_event_identity");
    expect(report.provenance).toEqual({ observed: 3, synthetic: 0 });
    expect(report.signalOrigins).toEqual({ annotated: 3, model: 0 });
    // Without extracted identity, the same publisher's different-language titles still do not match.
    const titleOnly = cases.map(row => ({ ...row, a: { ...row.a, eventSignal: undefined }, b: { ...row.b, eventSignal: undefined } }));
    expect(evaluateEventPairs(titleOnly).failures.map(row => row.id)).toEqual(["official-bilingual-45"]);
  });
  it("reports false merges separately from missed merges", () => {
    const different = { ...pair("base").b, title: "地方政府出台城市交通管理新规" };
    const report = evaluateEventPairs([
      pair("tp"), pair("fp", { expected: "separate" }),
      pair("tn", { expected: "separate", b: different }), pair("fn", { b: different }),
    ]);
    expect(report.confusion).toEqual({ truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1 });
    expect(report.precision).toBe(0.5);
    expect(report.recall).toBe(0.5);
    expect(report.falseMergeRate).toBe(0.5);
    expect(report.failures.map((row) => row.id)).toEqual(["fp", "fn"]);
  });
  it("keeps development, holdout and provenance counts distinct", () => {
    const report = evaluateEventPairs([pair("dev"), pair("held", { split: "holdout", provenance: "observed" })], "holdout");
    expect(report.cases).toBe(1);
    expect(report.provenance).toEqual({ synthetic: 0, observed: 1 });
    expect(() => evaluateEventPairs([pair("dev")], "holdout")).toThrow("No event cases");
  });
  it("does not claim perfect precision or recall without supporting cases", () => {
    const report = evaluateEventPairs([pair("invalid-date", { expected: "separate", b: { ...pair("base").b, date: "" } })]);
    expect(report.accuracy).toBe(1);
    expect(report.precision).toBeNull();
    expect(report.recall).toBeNull();
    expect(report.f1).toBeNull();
  });
  it("rejects missing labels, invalid platforms, duplicate ids and empty input", () => {
    expect(() => parseEventEvaluationCases([{ ...pair("missing"), expected: undefined }])).toThrow();
    expect(() => parseEventEvaluationCases([{ ...pair("platform"), a: { ...pair("base").a, platform: "other" } }])).toThrow();
    expect(() => parseEventEvaluationCases([pair("duplicate"), pair("duplicate")])).toThrow("Duplicate");
    expect(() => parseEventEvaluationCases([])).toThrow();
  });
});
