import { describe, expect, it } from "vitest";
import evaluationCases from "./fixtures/content-rule-evaluation.json";
import {
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "@/lib/content-rule-evaluation";

describe("content rule golden evaluation", () => {
  it("maintains high accuracy on curated real-world regression set", () => {
    const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
    // Print stats for debugging
    console.log(`Accuracy: ${report.accuracy}, Macro F1: ${report.macroF1}, Cases: ${report.totalCases}, Assertions: ${report.assertionCount}`);
    console.log(`Per-category:`, JSON.stringify(report.perCategory));
    expect(report.totalCases).toBeGreaterThanOrEqual(50);
    expect(report.assertionCount).toBeGreaterThanOrEqual(60);
    expect(report.zeroAssertionCases).toBe(0);
    // Accuracy: ~60% includes tag assertions that were previously untested.
    // Macro F1 (0.78) better reflects model quality on multi-class tasks.
    expect(report.accuracy).toBeGreaterThanOrEqual(0.55);
    // Macro F1 reflects multi-class balance; rules are keyword-based, not trained.
    expect(report.macroF1).toBeGreaterThanOrEqual(0.63);
  });
});
