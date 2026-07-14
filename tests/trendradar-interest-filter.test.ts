import { describe, expect, it } from "vitest";
import {
  filterTrendRadarItems,
  isTrendRadarInteresting,
  parseEditableFrequencyWordsConfig,
  parseFrequencyWordsConfig,
} from "@/lib/trendradar-interest-filter";

describe("TrendRadar interest filter", () => {
  it("parses include groups and global filters from frequency_words.txt", () => {
    const rules = parseFrequencyWordsConfig(`
[GLOBAL_FILTER]
标题党

[WORD_GROUPS]
[人工智能]
/\\bAI\\b|人工智能|Agent/i
[科技产业]
芯片
`);

    expect(rules.include).toHaveLength(2);
    expect(rules.exclude).toHaveLength(1);
    expect(rules.include.some((pattern) => pattern.test("AI Agent 新工具"))).toBe(true);
    expect(rules.exclude[0].test("标题党新闻")).toBe(true);
  });

  it("shows older simple regex defaults as one keyword per line for normal users", () => {
    const editable = parseEditableFrequencyWordsConfig(`
[GLOBAL_FILTER]
标题党

[WORD_GROUPS]
[人工智能]
/\\bAI\\b|人工智能|大模型|智能体|Agent|LLM/i
`);

    expect(editable.groups[0].keywords).toEqual(["AI", "人工智能", "大模型", "智能体", "Agent", "LLM"]);
  });

  it("keeps user-generated advanced regex as one editable rule", () => {
    const editable = parseEditableFrequencyWordsConfig(`
[WORD_GROUPS]
[人工智能]
/(AI|人工智能|大模型|Agent)/i
`);

    expect(editable.groups[0].keywords).toEqual(["/(AI|人工智能|大模型|Agent)/i"]);
  });

  it("does not let the short AI keyword match baidu by accident", () => {
    const rules = parseFrequencyWordsConfig(`
[WORD_GROUPS]
[人工智能]
AI
`);

    expect(rules.include[0].test("百度热搜 baidu")).toBe(false);
    expect(rules.include[0].test("AI时代的新工具")).toBe(true);
  });

  it("drops unrelated Baidu hotlist rows whose only accidental hit is baidu", () => {
    const row = {
      title: "多省开始“抢”老人",
      text: "多省开始“抢”老人",
      authorName: "百度热搜",
      authorHandle: "baidu",
    };

    expect(isTrendRadarInteresting(row)).toBe(false);
  });

  it("matches interest rules against content only, not source or domain metadata", () => {
    const row = {
      title: "今日普通热点",
      text: "这是一条没有科技主题的普通消息",
      authorName: "OpenAI Daily",
      authorHandle: "openai-ai-news",
    };

    expect(isTrendRadarInteresting(row)).toBe(false);
  });

  it("keeps relevant TrendRadar rows and drops unrelated hotlist noise", () => {
    const rows = [
      { title: "OpenAI 发布新模型", text: "大模型能力更新", authorName: "知乎", authorHandle: "zhihu" },
      { title: "演唱会门票售罄", text: "娱乐新闻", authorName: "微博", authorHandle: "weibo" },
    ];

    expect(filterTrendRadarItems(rows)).toEqual([rows[0]]);
  });
});
