import { describe, expect, it } from "vitest";
import { extractMonitorRulesFromConfig } from "@/lib/monitor-rules";

describe("monitor rule extraction", () => {
  it("uses one shared config mapping for collection and backfill", () => {
    expect(extractMonitorRulesFromConfig({
      keywords: ["OpenAI", 123],
      requiredKeywords: ["模型"],
      excludeKeywords: ["招聘"],
      contentTypeFilters: ["model_release"],
      topicFilters: ["Agent"],
    })).toEqual({
      keywords: ["OpenAI"],
      requiredKeywords: ["模型"],
      excludeKeywords: ["招聘"],
      contentTypeFilters: ["model_release"],
      topicFilters: ["Agent"],
    });
  });

  it("returns undefined when no Gate or Rank rules are configured", () => {
    expect(extractMonitorRulesFromConfig({ provider: "brave", query: "AI" }))
      .toBeUndefined();
  });
});
