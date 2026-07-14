import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sampleConfig = `app:
  timezone: "Asia/Shanghai"

platforms:
  enabled: true
  api_url: ""
  sources:
    - id: "toutiao"
      name: "今日头条"
      expected_domain: "toutiao.com"
    - id: "zhihu"
      name: "知乎"
      expected_domain: "zhihu.com"

# ===============================================================
# 3. 数据源 - RSS 订阅
# ===============================================================
rss:
  enabled: true
  freshness_filter:
    enabled: true
    max_age_days: 1
  feeds:
    - id: "hacker-news"
      name: "Hacker News"
      url: "https://hnrss.org/frontpage"
    - id: "ruanyifeng"
      name: "阮一峰的网络日志"
      url: "http://www.ruanyifeng.com/blog/atom.xml"
      enabled: false

report:
  mode: "current"
`;

async function importWithConfigDir(configDir: string) {
  vi.resetModules();
  process.env.TRENDRADAR_CONFIG_DIR = configDir;
  return import("@/lib/trendradar-config");
}

afterEach(() => {
  delete process.env.TRENDRADAR_CONFIG_DIR;
  vi.resetModules();
});

describe("TrendRadar config editor", () => {
  it("loads hot-list catalog state and RSS feeds from config.yaml", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trendradar-config-"));
    await writeFile(path.join(dir, "config.yaml"), sampleConfig, "utf8");
    const { loadTrendRadarSourcesConfig } = await importWithConfigDir(dir);

    const config = await loadTrendRadarSourcesConfig();

    expect(config.platformsEnabled).toBe(true);
    expect(config.rssEnabled).toBe(true);
    expect(config.platformSources.find((source) => source.id === "toutiao")?.enabled).toBe(true);
    expect(config.platformSources.find((source) => source.id === "baidu")?.enabled).toBe(false);
    expect(config.rssFeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "hacker-news", enabled: true }),
        expect.objectContaining({ id: "ruanyifeng", enabled: false }),
      ]),
    );
  });

  it("saves only the source blocks while keeping the rest of config.yaml", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trendradar-config-"));
    const file = path.join(dir, "config.yaml");
    await writeFile(file, sampleConfig, "utf8");
    const { loadTrendRadarSourcesConfig, saveTrendRadarSourcesConfig } = await importWithConfigDir(dir);

    const before = await loadTrendRadarSourcesConfig();
    await saveTrendRadarSourcesConfig({
      ...before,
      platformsEnabled: true,
      rssEnabled: true,
      platformSources: before.platformSources.map((source) => ({
        ...source,
        enabled: source.id === "baidu",
      })),
      rssFeeds: [
        { id: "hacker-news", name: "Hacker News", url: "https://hnrss.org/frontpage", enabled: false },
        { id: "custom-ai", name: "AI Blog", url: "https://example.com/feed.xml", enabled: true },
      ],
    });

    const raw = await readFile(file, "utf8");
    expect(raw).toContain('app:\n  timezone: "Asia/Shanghai"');
    expect(raw).toContain('report:\n  mode: "current"');
    expect(raw).toContain('    - id: "baidu"');
    expect(raw).not.toContain('    - id: "toutiao"');
    expect(raw).toContain('    - id: "custom-ai"');
    expect(raw).toContain('      enabled: false');
  });
});
