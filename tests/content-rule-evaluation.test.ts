import { describe, expect, it } from "vitest";
import evaluationCases from "./fixtures/content-rule-evaluation.json";
import {
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "@/lib/content-rule-evaluation";

describe("content rule golden evaluation", () => {
  it("keeps the curated real-world regression set at full accuracy", () => {
    const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.accuracy).toBe(1);
    expect(report.totalCases).toBeGreaterThanOrEqual(15);
    expect(report.assertionCount).toBeGreaterThanOrEqual(30);
  });
});
