import Link from "next/link";
import { Bookmark, ChevronDown, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { loadReaderFeed, loadWechatKeywordRuleFilters } from "@/lib/reader-data";
import { TimelineCard } from "@/components/timeline-card";
import type { PlatformType } from "@/connectors/types";
import { CONTENT_TYPE_FILTERS, contentTypeFromLegacyTag, getContentTypeFilter } from "@/lib/item-tags";

export const dynamic = "force-dynamic";

const PLATFORM_TABS: { key: string; label: string; platform?: PlatformType }[] = [
  { key: "all", label: "全部" },
  { key: "x", label: "X / Twitter", platform: "x" },
  { key: "wechat", label: "微信公众号", platform: "wechat" },
  { key: "web_search", label: "全网搜索", platform: "web_search" },
  { key: "trendradar", label: "热榜 / RSS", platform: "trendradar" },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; q?: string; monitor?: string; type?: string; tag?: string; topic?: string }>;
}) {
  const sp = await searchParams;
  const activeKey = sp.platform ?? "all";
  const search = sp.q?.trim() || undefined;
  const activeMonitorId = sp.monitor?.trim() || undefined;
  const activeContentTypeId = getContentTypeFilter(sp.type)?.id ?? contentTypeFromLegacyTag(sp.tag);
  const activeTopic = sp.topic?.replace(/^#+/, "").trim() || undefined;
  const activeTab = PLATFORM_TABS.find((t) => t.key === activeKey) ?? PLATFORM_TABS[0];
  const keywordRuleFilters = activeTab.platform === "wechat" ? await loadWechatKeywordRuleFilters() : [];
  const selectedKeywordRule = keywordRuleFilters.find((rule) => rule.id === activeMonitorId);

  const { items, usingDemo } = await loadReaderFeed({
    platform: activeTab.platform,
    search,
    monitorId: selectedKeywordRule?.id,
    contentType: activeContentTypeId,
    topic: activeTopic,
  });
  const now = new Date().toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });

  // 顶部分组标题显示信息流中最新一篇的发布日期（按北京时间），不再写死。
  const latestItemDate = items[0]?.date ? new Date(items[0].date) : new Date();
  const latestDateLabel = latestItemDate.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  });

  const tabHref = (key: string) => {
    const params = new URLSearchParams();
    if (key !== "all") params.set("platform", key);
    if (search) params.set("q", search);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    if (activeTopic) params.set("topic", activeTopic);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const wechatFilterHref = (monitorId?: string) => {
    const params = new URLSearchParams();
    params.set("platform", "wechat");
    if (search) params.set("q", search);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    if (activeTopic) params.set("topic", activeTopic);
    if (monitorId) params.set("monitor", monitorId);
    return `/?${params.toString()}`;
  };

  const contentTypeHref = (typeId?: string) => {
    const params = new URLSearchParams();
    if (activeKey !== "all") params.set("platform", activeKey);
    if (search) params.set("q", search);
    if (selectedKeywordRule) params.set("monitor", selectedKeywordRule.id);
    if (activeTopic) params.set("topic", activeTopic);
    if (typeId) params.set("type", typeId);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const topicHref = (topic: string) => {
    const params = new URLSearchParams();
    params.set("topic", topic);
    return `/?${params.toString()}`;
  };

  const clearTopicHref = () => {
    const params = new URLSearchParams();
    if (activeKey !== "all") params.set("platform", activeKey);
    if (search) params.set("q", search);
    if (selectedKeywordRule) params.set("monitor", selectedKeywordRule.id);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  return (
    <main className="reader-page">
      {usingDemo && (
        <div className="demo-banner">
          演示数据：未连接数据库，配置 <code>DATABASE_URL</code> 后展示实时信息流。
        </div>
      )}

      <section className="reader-hero">
        <div>
          <div className="eyebrow">
            <Sparkles size={14} /> 今日信息流
          </div>
          <h1>最新</h1>
          <p>来自你订阅的账号与关键词监控，多平台持续更新。</p>
        </div>
        <div className="hero-stat">
          <strong>{items.length}</strong>
          <span>当前条目</span>
        </div>
      </section>

      <section className="filter-panel" aria-label="信息筛选">
        <div className="filter-left">
          <div className="platform-tabs">
            {PLATFORM_TABS.map((t) => (
              <Link key={t.key} href={tabHref(t.key)} className={t.key === activeKey ? "active" : ""}>
                {t.label}
              </Link>
            ))}
          </div>
          {activeTab.platform === "wechat" && keywordRuleFilters.length > 0 && (
            <div className="rule-tabs" aria-label="公众号关键词规则筛选">
              <Link href={wechatFilterHref()} className={!selectedKeywordRule ? "active" : ""}>
                全部公众号文章
              </Link>
              {keywordRuleFilters.map((rule) => (
                <Link key={rule.id} href={wechatFilterHref(rule.id)} className={selectedKeywordRule?.id === rule.id ? "active" : ""}>
                  {rule.name}
                  <span>{rule.itemCount}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="tag-filter-row" aria-label="内容类型筛选">
            <span className="filter-label">内容类型</span>
            <Link href={contentTypeHref()} className={!activeContentTypeId ? "active" : ""}>
              全部
            </Link>
            {CONTENT_TYPE_FILTERS.map((type) => (
              <Link key={type.id} href={contentTypeHref(type.id)} className={activeContentTypeId === type.id ? "active" : ""} title={type.description}>
                {type.label}
              </Link>
            ))}
          </div>
          {activeTopic && (
            <div className="topic-filter-row" aria-label="主题标签筛选">
              <span className="filter-label">主题</span>
              <span className="active-topic">#{activeTopic}</span>
              <Link href={clearTopicHref()} className="clear-topic">
                清除
              </Link>
            </div>
          )}
        </div>
        <form className="filter-actions" action="/" method="get">
          <label className="search-box">
            <Search size={16} />
            <input name="q" defaultValue={search ?? ""} aria-label="搜索信息" placeholder="搜索标题、正文、账号…" />
          </label>
          <input type="hidden" name="platform" value={activeKey} />
          {selectedKeywordRule && <input type="hidden" name="monitor" value={selectedKeywordRule.id} />}
          {activeContentTypeId && <input type="hidden" name="type" value={activeContentTypeId} />}
          {activeTopic && <input type="hidden" name="topic" value={activeTopic} />}
          <button className="icon-button" type="submit" aria-label="搜索">
            <SlidersHorizontal size={17} />
          </button>
        </form>
      </section>

      <div className="date-row">
        <button>
          {latestDateLabel} <ChevronDown size={14} />
        </button>
        <span>最近更新于 {now}</span>
      </div>

      <section className="timeline" aria-label="信息时间线">
        {items.length > 0 ? (
          items.map((item) => <TimelineCard item={item} key={item.id} topicHref={topicHref} />)
        ) : (
          <div className="empty-state">
            {search ? (
              <p>未找到匹配“{search}”的信息。</p>
            ) : activeTopic ? (
              <p>暂无 #{activeTopic} 相关内容。可以清除主题标签，或等待后续采集。</p>
            ) : activeTab.platform ? (
              <p>
                {activeTab.label} 暂无可显示内容。请在{" "}
                <Link href="/admin" className="inline-link">
                  后台
                </Link>{" "}
                添加该平台监控，并配置对应 API 密钥（X_BEARER_TOKEN / WERSS_ACCESS_KEY / BRAVE_SEARCH_API_KEY）后采集。
              </p>
            ) : (
              <p>暂无信息，采集任务运行后将在此显示。</p>
            )}
          </div>
        )}
      </section>
      <button className="floating-save" aria-label="查看收藏">
        <Bookmark size={18} />
      </button>
    </main>
  );
}
