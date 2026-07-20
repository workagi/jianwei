import { describe, expect, it } from "vitest";
import type { NormalizedItem } from "@/connectors/types";
import { buildContentRouteOutcome } from "@/lib/content-router";

function item(): NormalizedItem {
  return {
    platform: "trendradar",
    upstreamId: "route-1",
    canonicalUrl: "https://example.com/route-1",
    title: "OpenAI 发布新的 Codex Agent 产品",
    text: "新产品面向开发者提供 Agent 工作流，并公布订阅价格。",
    imageUrls: [],
    publishedAt: new Date("2026-07-15T08:00:00Z"),
    raw: {},
  };
}

describe("content router outcomes", () => {
  it("marks a complete structured model response as success", () => {
    const result = buildContentRouteOutcome(item(), {
      status: "success",
      translatedTitle: "OpenAI 发布全新 Codex Agent 产品",
      summary: "OpenAI 发布 Codex Agent 产品，为开发者提供自动化工作流能力。",
      contentType: "product_update",
      topicTags: ["OpenAI", "Codex", "Agent"],
      retentionReason: "明确说明 Codex Agent 的新增能力和使用方式",
      relevanceScore: 86,
      provider: "openai-compatible",
      model: "step-3.5-flash-2603",
    });

    expect(result.status).toBe("success");
    expect(result.translatedTitle).toBe("OpenAI 发布全新 Codex Agent 产品");
    expect(result.classificationSource).toBe("model");
    expect(result.retentionSource).toBe("model");
    expect(result.retentionReason).toContain("Codex Agent");
    expect(result.relevanceScore).toBe(86);
    expect(result.attempts).toBe(1);
  });

  it("keeps a usable summary but records rule fallback as partial", () => {
    const result = buildContentRouteOutcome(item(), {
      status: "success",
      summary: "OpenAI 发布 Codex Agent 产品，为开发者提供自动化工作流能力。",
      provider: "openai-compatible",
    });

    expect(result.status).toBe("partial");
    expect(result.classificationSource).toBe("rules");
    expect(result.contentType).toBe("product_update");
    expect(result.topicTags).toEqual(expect.arrayContaining(["OpenAI", "Agent"]));
    expect(result.retentionSource).toBe("rules");
    expect(result.retentionReason).toBe("");
    expect(result.relevanceScore).toBeGreaterThan(50);
  });

  it("keeps complete classification partial until the model returns a concrete recommendation reason", () => {
    const result = buildContentRouteOutcome(item(), {
      status: "success",
      translatedTitle: "OpenAI 发布新的 Codex Agent 产品",
      summary: "OpenAI 发布 Codex Agent 产品，为开发者提供自动化工作流能力。",
      contentType: "product_update",
      topicTags: ["OpenAI", "Codex"],
      provider: "openai-compatible",
    });

    expect(result.status).toBe("partial");
    expect(result.classificationSource).toBe("model");
    expect(result.retentionSource).toBe("rules");
    expect(result.retentionReason).toBe("");
  });

  it("requires a Chinese display translation for X before marking analysis complete", () => {
    const xItem = {
      ...item(),
      platform: "x" as const,
      title: undefined,
      text: "OpenAI launched a new Codex workflow today.",
    };
    const result = buildContentRouteOutcome(xItem, {
      status: "success",
      summary: "OpenAI 发布了新的 Codex 工作流。",
      contentType: "product_update",
      topicTags: ["OpenAI", "Codex"],
      retentionReason: "OpenAI 明确发布新的 Codex 工作流，提供了可核验的产品变化。",
      relevanceScore: 82,
    });

    expect(result.status).toBe("partial");
  });

  it("does not disguise a provider failure as a model success", () => {
    const result = buildContentRouteOutcome(item(), {
      status: "rate_limited",
      provider: "openai-compatible",
      errorCode: "SUMMARY_RATE_LIMITED",
      errorMessage: "HTTP 429",
    });

    expect(result.status).toBe("failed");
    expect(result.classificationSource).toBe("rules");
    expect(result.attempts).toBe(1);
    expect(result.errorCode).toBe("SUMMARY_RATE_LIMITED");
  });

  it("records disabled and skipped routes without charging an attempt", () => {
    expect(buildContentRouteOutcome(item(), { status: "disabled" })).toMatchObject({
      status: "disabled",
      attempts: 0,
    });
    expect(buildContentRouteOutcome(item(), { status: "skipped", errorCode: "FULL_TEXT_REQUIRED" })).toMatchObject({
      status: "skipped",
      attempts: 0,
    });
  });
});
