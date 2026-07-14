import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "@/connectors/web/query-builder";

describe("buildSearchQuery", () => {
  it("combines exact phrases, exclusions and domains", () => {
    expect(buildSearchQuery({
      query: "AI agent",
      exactPhrases: ["Claude Code"],
      excludedTerms: ["招聘"],
      includeDomains: ["openai.com"],
      excludeDomains: ["example.com"],
      resultType: "both",
    })).toBe('AI agent "Claude Code" -招聘 site:openai.com -site:example.com');
  });
});
