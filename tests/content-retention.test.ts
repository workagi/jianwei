import { describe, expect, it } from "vitest";
import type { NormalizedItem } from "@/connectors/types";
import {
  deriveRetentionDecision,
  normalizeRelevanceScore,
  normalizeRetentionReason,
} from "@/lib/content-retention";

const item: NormalizedItem = {
  platform: "web_search",
  upstreamId: "retention-1",
  canonicalUrl: "https://example.com/retention-1",
  title: "OpenAI 发布 Codex Agent 更新",
  text: "OpenAI 为 Codex 增加可持续执行的 Agent 工作流，并公布新的开发者使用方式。",
  publishedAt: new Date("2026-07-15T08:00:00Z"),
  raw: {},
};

describe("content retention", () => {
  it("uses a complete model decision", () => {
    expect(deriveRetentionDecision({
      item,
      contentType: "product_update",
      topicTags: ["OpenAI", "Agent"],
      summary: "Codex 增加持续执行能力。",
      modelReason: "明确给出 Codex Agent 的新增能力与使用方式",
      modelScore: 86,
    })).toEqual({
      reason: "明确给出 Codex Agent 的新增能力与使用方式",
      relevanceScore: 86,
      source: "model",
    });
  });

  it("degrades per-field: uses model score but rules reason when model reason is filtered", () => {
    const result = deriveRetentionDecision({
      item,
      contentType: "product_update",
      topicTags: ["OpenAI", "Agent"],
      modelReason: "值得一读",
      modelScore: 99,
    });
    // modelScore is valid → source is "model"; modelReason filtered → falls back to rules
    expect(result.source).toBe("model");
    expect(result.reason).toContain("OpenAI、Agent");
    expect(result.relevanceScore).toBe(99);
  });

  it("removes generic or malformed legacy tags from fallback copy", () => {
    const result = deriveRetentionDecision({
      item,
      contentType: "industry_business",
      topicTags: ["AI", "URL", "有Arista", "Networks"],
    });
    expect(result.reason).toBe("包含Arista、Networks相关的行业商业信息");
  });

  it("normalizes scores and rejects generic or leaked reasons", () => {
    expect(normalizeRelevanceScore("120")).toBe(100);
    expect(normalizeRelevanceScore(-3)).toBe(0);
    expect(normalizeRetentionReason("推荐理由：明确列出了三项产品更新")).toBe("明确列出了三项产品更新");
    expect(normalizeRetentionReason("内容丰富，值得阅读")).toBeUndefined();
    expect(normalizeRetentionReason("keep_reason 应该写得具体")).toBeUndefined();
    expect(normalizeRetentionReason("包含Grok、AI Agent相关的产品动态信息")).toBeUndefined();
    expect(normalizeRetentionReason("包含可核对的论文研究信息")).toBeUndefined();
    expect(normalizeRetentionReason("包含有明确主题的观点解读")).toBeUndefined();
    expect(normalizeRetentionReason("来自已配置监控任务的可核对信息")).toBeUndefined();
  });
});
