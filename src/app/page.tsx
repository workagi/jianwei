import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { groupReaderItemsByDate, loadReaderFeed, loadWechatKeywordRuleFilters } from "@/lib/reader-data";
import { TimelineCard } from "@/components/timeline-card";
import { FeaturedTop } from "@/components/featured-top";
import type { PlatformType } from "@/connectors/types";
import { CONTENT_TYPE_FILTERS, contentTypeFromLegacyTag, getContentTypeFilter } from "@/lib/item-tags";
import { selectTopFeaturedEvents } from "@/lib/content-clustering";

export const dynamic = "force-dynamic";

const PLATFORM_TABS: { key: string; label: string; platform?: PlatformType }[] = [
  { key: "all", label: "全部" },
  { key: "x", label: "X / Twitter", platform: "x" },
  { key: "wechat", label: "微信公众号", platform: "wechat" },
  { key: "web_search", label: "全网搜索", platform: "web_search" },
  { key: "trendradar", label: "榜单 / RSS", platform: "trendradar" },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; platform?: string; q?: string; monitor?: string; type?: string; tag?: string; topic?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const isLatestView = sp.view === "latest";
  const isFeaturedView = sp.view === "featured" || (!sp.view && sp.platform === undefined);
  const isStreamView = isFeaturedView || isLatestView;
  const readerMode = isFeaturedView ? "featured" : isLatestView ? "latest" : "archive";
  const activeKey = sp.platform ?? "all";
  const search = sp.q?.trim() || undefined;
  const activeMonitorId = sp.monitor?.trim() || undefined;
  const activeContentTypeId = getContentTypeFilter(sp.type)?.id ?? contentTypeFromLegacyTag(sp.tag);
  const activeTopic = sp.topic?.replace(/^#+/, "").trim() || undefined;
  const requestedPage = Number(sp.page);
  const activePage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const activeTab = PLATFORM_TABS.find((t) => t.key === activeKey) ?? PLATFORM_TABS[0];
  const keywordRuleFilters = activeTab.platform === "wechat" ? await loadWechatKeywordRuleFilters() : [];
  const selectedKeywordRule = keywordRuleFilters.find((rule) => rule.id === activeMonitorId);
  const latestSince = isStreamView ? new Date() : undefined;
  if (latestSince) latestSince.setHours(latestSince.getHours() - (isFeaturedView ? 72 : 24));

  const feed = await loadReaderFeed({
    platform: activeTab.platform,
    search,
    monitorId: selectedKeywordRule?.id,
    contentType: activeContentTypeId,
    topic: activeTopic,
    since: latestSince,
    page: activePage,
    mode: readerMode,
  });
  const { items, usingDemo, total, totalIsExact, page, hasPrevious, hasNext, balancedOverview } = feed;
  const now = new Date().toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });

  const dateGroups = groupReaderItemsByDate(items);

  const tabHref = (key: string) => {
    const params = new URLSearchParams();
    if (isStreamView) {
      params.set("view", isFeaturedView ? "featured" : "latest");
      if (key !== "all") params.set("platform", key);
    } else {
      params.set("platform", key);
    }
    if (search) params.set("q", search);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    if (activeTopic) params.set("topic", activeTopic);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const wechatFilterHref = (monitorId?: string) => {
    const params = new URLSearchParams();
    if (isStreamView) params.set("view", isFeaturedView ? "featured" : "latest");
    params.set("platform", "wechat");
    if (search) params.set("q", search);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    if (activeTopic) params.set("topic", activeTopic);
    if (monitorId) params.set("monitor", monitorId);
    return `/?${params.toString()}`;
  };

  const contentTypeHref = (typeId?: string) => {
    const params = new URLSearchParams();
    if (isStreamView) {
      params.set("view", isFeaturedView ? "featured" : "latest");
      if (activeKey !== "all") params.set("platform", activeKey);
    } else {
      params.set("platform", activeKey);
    }
    if (search) params.set("q", search);
    if (selectedKeywordRule) params.set("monitor", selectedKeywordRule.id);
    if (activeTopic) params.set("topic", activeTopic);
    if (typeId) params.set("type", typeId);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const topicHref = (topic: string) => {
    const params = new URLSearchParams();
    if (isStreamView) params.set("view", isFeaturedView ? "featured" : "latest");
    else params.set("platform", activeKey);
    if (activeKey !== "all") params.set("platform", activeKey);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    params.set("topic", topic);
    return `/?${params.toString()}`;
  };

  const clearTopicHref = () => {
    const params = new URLSearchParams();
    if (isStreamView) {
      params.set("view", isFeaturedView ? "featured" : "latest");
      if (activeKey !== "all") params.set("platform", activeKey);
    } else {
      params.set("platform", activeKey);
    }
    if (search) params.set("q", search);
    if (selectedKeywordRule) params.set("monitor", selectedKeywordRule.id);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const pageHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (isStreamView) params.set("view", isFeaturedView ? "featured" : "latest");
    if (activeKey !== "all" || !isStreamView) params.set("platform", activeKey);
    if (search) params.set("q", search);
    if (selectedKeywordRule) params.set("monitor", selectedKeywordRule.id);
    if (activeContentTypeId) params.set("type", activeContentTypeId);
    if (activeTopic) params.set("topic", activeTopic);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const historicalDescription = balancedOverview
    ? "跨平台均衡概览，避免站点榜单淹没公众号和搜索；完整历史可进入各平台查看。"
    : `${activeTab.label}历史内容，可按类型、主题和关键词回看。`;
  const showFeaturedTop = isFeaturedView && activeKey === "all" && !search && !activeContentTypeId && !activeTopic && !selectedKeywordRule;
  const featuredTop = showFeaturedTop ? selectTopFeaturedEvents(items) : [];

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
            <Sparkles size={14} /> {isFeaturedView ? "今日精选" : "今日信息流"}
          </div>
          <h1>{isFeaturedView ? "精选" : isLatestView ? "最新" : "全部信息"}</h1>
          <p>{isFeaturedView ? "过去 3 天达到质量门槛的内容；重点榜按综合价值排序，时间流按发布时间更新。" : isLatestView ? "近 24 小时的新动态，多平台持续更新。" : historicalDescription}</p>
        </div>
        <div className="hero-stat">
          <strong>{totalIsExact ? total : `≥${total}`}</strong>
          <span>{isFeaturedView ? `当前 ${items.length} 个事件` : balancedOverview ? `已收录 · 当前展示 ${items.length}` : `已收录 · 第 ${page} 页`}</span>
        </div>
      </section>

      <FeaturedTop items={featuredTop} />

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
          {isStreamView && <input type="hidden" name="view" value={isFeaturedView ? "featured" : "latest"} />}
          {selectedKeywordRule && <input type="hidden" name="monitor" value={selectedKeywordRule.id} />}
          {activeContentTypeId && <input type="hidden" name="type" value={activeContentTypeId} />}
          {activeTopic && <input type="hidden" name="topic" value={activeTopic} />}
          <button className="icon-button" type="submit" aria-label="搜索">
            <SlidersHorizontal size={17} />
          </button>
        </form>
      </section>

      {dateGroups.length > 0 ? dateGroups.map((group, index) => (
        <div className="timeline-day" key={group.key}>
          <div className="date-row">
            <div className="date-label">
              {group.label}
            </div>
            <span
              className="date-context"
              title={isFeaturedView ? "精选表示达到质量门槛，不代表每张卡片的名次；下方按发布时间倒序。" : undefined}
            >
              {group.weekday} · {group.items.length} {isFeaturedView ? "个事件 · 入选后按时间倒序" : "条"}
            </span>
            {index === 0 && <span>最近更新于 {now}</span>}
          </div>
          <section className="timeline" aria-label={`${group.label}信息时间线`}>
            {group.items.map((item) => <TimelineCard item={item} key={item.id} topicHref={topicHref} />)}
          </section>
        </div>
      )) : (
        <section className="timeline" aria-label="信息时间线">
          <div className="empty-state">
            {search ? (
              <p>未找到匹配“{search}”的信息。</p>
            ) : activeTopic ? (
              <p>暂无 #{activeTopic} 相关内容。可以清除主题标签，或等待后续采集。</p>
            ) : isFeaturedView ? (
              <p>过去 3 天暂无达到精选标准的内容，可以切换到“最新”查看全部新动态。</p>
            ) : activeTab.platform ? (
              <p>
                {activeTab.label} 暂无可显示内容。请在{" "}
                <Link href="/admin" className="inline-link">
                  后台
                </Link>{" "}
                添加该平台监控，并到{" "}
                <Link href="/admin/connectors" className="inline-link">
                  平台连接
                </Link>{" "}
                配好对应服务后等待采集。
              </p>
            ) : (
              <p>暂无信息，采集任务运行后将在此显示。</p>
            )}
          </div>
        </section>
      )}
      {!balancedOverview && (hasPrevious || hasNext) && (
        <nav className="reader-pagination" aria-label="信息流分页">
          {hasPrevious ? (
            <Link href={pageHref(page - 1)} className="pagination-link"><ChevronLeft size={15} />上一页</Link>
          ) : <span />}
          <span>第 {page} 页 · 本页 {items.length} 条</span>
          {hasNext ? (
            <Link href={pageHref(page + 1)} className="pagination-link">下一页<ChevronRight size={15} /></Link>
          ) : <span />}
        </nav>
      )}
    </main>
  );
}
