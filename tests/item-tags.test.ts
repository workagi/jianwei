import { describe, expect, it } from "vitest";
import { deriveItemClassification, itemMatchesContentType, itemMatchesTopic, normalizeContentType, normalizeTopicTags } from "@/lib/item-tags";

const base = {
  platform: "wechat" as const,
  authorName: "测试账号",
  authorHandle: null,
  aiSummary: null,
};

describe("item tag derivation", () => {
  it("separates content type from topic tags across sources", () => {
    const item = {
      ...base,
      title: "用 AI Agent 自动化整理信息流的实践技巧",
      bodyText: "这是一篇关于智能体工作流、Prompt 模板和 MCP 工具调用的教程。",
    };

    const classification = deriveItemClassification(item);
    expect(classification.contentType).toBe("tutorial");
    expect(classification.topicTags).toEqual(expect.arrayContaining(["Agent", "MCP", "Prompt"]));
    expect(itemMatchesContentType(item, "tutorial")).toBe(true);
  });

  it("uses policy safety as the primary type while keeping source-independent topic tags", () => {
    const item = {
      ...base,
      platform: "web_search" as const,
      authorName: "Example News",
      title: "OpenAI 新模型发布前接受安全监管评估",
      bodyText: "报道提到 GPT 模型、对齐风险、隐私和政策合规要求。",
    };

    const classification = deriveItemClassification(item);
    expect(classification.contentType).toBe("policy_safety");
    expect(classification.topicTags).toEqual(expect.arrayContaining(["OpenAI", "安全/对齐"]));
    expect(itemMatchesContentType(item, "policy_safety")).toBe(true);
  });

  it("normalizes AI-provided content type and topic tags", () => {
    expect(normalizeContentType("论文研究")).toBe("research");
    expect(normalizeTopicTags(["#Agent", " Agent ", "", "多模态"])).toEqual(["Agent", "多模态"]);
  });

  it("matches topic tags by content-derived labels", () => {
    const item = {
      ...base,
      title: "OpenAI Codex 并入 ChatGPT",
      bodyText: "这次产品更新和 Agent 工作流有关。",
      topicTags: ["OpenAI", "Agent"],
    };

    expect(itemMatchesTopic(item, "#openai")).toBe(true);
    expect(itemMatchesTopic(item, "Agent")).toBe(true);
    expect(itemMatchesTopic(item, "DeepSeek")).toBe(false);
  });

  it("extracts useful fallback tags for short hot-list titles", () => {
    const market = {
      ...base,
      platform: "trendradar" as const,
      title: "地缘风暴叠加鹰派理事，美股指齐跌，半导体指数重挫5%，原油飙升10%，黄金大跌",
      bodyText: "地缘风暴叠加鹰派理事，美股指齐跌，半导体指数重挫5%，原油飙升10%，黄金大跌",
    };

    expect(deriveItemClassification(market).topicTags).toEqual(
      expect.arrayContaining(["地缘政治", "美股", "半导体", "能源", "黄金"]),
    );
  });
});
