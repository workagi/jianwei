import { describe, expect, it } from "vitest";
import evaluationCases from "./fixtures/content-rule-evaluation.json";
import {
  CONTENT_RULE_MIN_ACCURACY,
  CONTENT_RULE_MIN_MACRO_F1,
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "@/lib/content-rule-evaluation";

describe("content rule golden evaluation", () => {
  it("maintains the measured regression floor on the curated rule set", () => {
    const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
    // Print stats for debugging
    console.log(`Accuracy: ${report.accuracy}, Macro F1: ${report.macroF1}, Cases: ${report.totalCases}, Assertions: ${report.assertionCount}`);
    console.log(`Per-category:`, JSON.stringify(report.perCategory));
    expect(report.totalCases).toBeGreaterThanOrEqual(50);
    expect(report.assertionCount).toBeGreaterThanOrEqual(60);
    expect(report.zeroAssertionCases).toBe(0);
    const categoryF1 = Object.values(report.perCategory).map((metrics) => metrics.f1);
    const expectedMacroF1 = categoryF1.reduce((sum, value) => sum + value, 0) / categoryF1.length;
    expect(report.macroF1).toBeCloseTo(expectedMacroF1, 4);
    // Accuracy includes tag assertions that were previously untested.
    expect(report.accuracy).toBeGreaterThanOrEqual(CONTENT_RULE_MIN_ACCURACY);
    // Macro F1 reflects multi-class balance; rules are keyword-based, not trained.
    expect(report.macroF1).toBeGreaterThanOrEqual(CONTENT_RULE_MIN_MACRO_F1);
  });

  it("treats legacy category labels as content-type expectations", () => {
    const report = evaluateContentRules([
      {
        id: "legacy-category-label",
        platform: "wechat",
        title: "DeepSeek 发布新一代模型",
        bodyText: "模型发布了新的上下文能力和评测结果。",
        expectedContentType: "model_release",
        expectedTopicTags: ["模型"],
      },
    ]);

    expect(report.failures).toEqual([]);
    expect(report.assertionCount).toBe(2);
  });
});
