import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { groupReaderItemsByDate, loadReaderFeed, loadReaderMonitorFilters } from "@/lib/reader-data";
import { TimelineCard } from "@/components/timeline-card";
import { FeaturedTop } from "@/components/featured-top";
import type { PlatformType } from "@/connectors/types";
import { CONTENT_TYPE_FILTERS, contentTypeFromLegacyTag, getContentTypeFilter } from "@/lib/item-tags";

import { readerHref } from "@/lib/reader-navigation";
import { loadContentPipelineView } from "@/lib/content-pipeline";

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
  searchParams: Promise<{ view?: string; platform?: string; q?: string; monitor?: string | string[]; type?: string; tag?: string; topic?: string; page?: string; followed?: string }>;
}) {
  const sp = await searchParams;
  const isChangesView = sp.view === "changes" || (!sp.view && sp.platform === undefined);
  const isFollowedView = sp.view === "followed";
  const isLatestView = sp.view === "latest";
  const isFeaturedView = sp.view === "featured";
  const isStreamView = isChangesView || isFeaturedView || isLatestView || isFollowedView;
  const readerMode = isFollowedView ? "followed" : isChangesView ? "changes" : isFeaturedView ? "featured" : isLatestView ? "latest" : "archive";
  const activeKey = sp.platform ?? "all";
  const search = sp.q?.trim() || undefined;
  const activeContentTypeId = getContentTypeFilter(sp.type)?.id ?? contentTypeFromLegacyTag(sp.tag);
  const activeTopic = sp.topic?.replace(/^#+/, "").trim() || undefined;
  const requestedPage = Number(sp.page);
  const activePage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const activeTab = PLATFORM_TABS.find((t) => t.key === activeKey) ?? PLATFORM_TABS[0];
  const monitorFilters = await loadReaderMonitorFilters();
  const requestedMonitors = new Set((Array.isArray(sp.monitor) ? sp.monitor : [sp.monitor]).filter(Boolean));
  const selectedRules = monitorFilters.filter(rule => requestedMonitors.has(rule.id));
  const selectedMonitorIds = selectedRules.map(rule => rule.id);
  const latestSince = isStreamView && !isFollowedView ? new Date() : undefined;
  if (latestSince) latestSince.setHours(latestSince.getHours() - (isChangesView ? 14 * 24 : isFeaturedView ? 72 : 24));

  const feed = await loadReaderFeed({
    platform: activeTab.platform,
    search,
    monitorIds: selectedMonitorIds,
    contentType: activeContentTypeId,
    topic: activeTopic,
    since: latestSince,
    page: activePage,
    mode: readerMode,
    followedOnly: isChangesView && sp.followed === "1",
  });
  const { items, usingDemo, total, totalIsExact, page, hasPrevious, hasNext, balancedOverview } = feed;
  const emptyPipeline = !items.length && !usingDemo && !feed.unavailable && (isChangesView || isFollowedView) ? await loadContentPipelineView() : undefined;
  const latestRecord = items.length ? new Date(Math.max(...items.map(item => new Date(item.date).getTime()))).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }) : undefined;

  const dateGroups = groupReaderItemsByDate(items);

  const filterState = {
    view: isStreamView ? readerMode : undefined,
    platform: activeKey !== "all" || !isStreamView ? activeKey : undefined,
    q: search,
    monitor: selectedMonitorIds,
    type: activeContentTypeId,
    topic: activeTopic,
    followed: isChangesView && sp.followed === "1" ? "1" : undefined,
  };
  const tabHref = (key: string) => readerHref(filterState, { platform: key !== "all" || !isStreamView ? key : undefined });
  const monitorHref = (monitorId?: string) => readerHref(filterState, { monitor: monitorId });
  const contentTypeHref = (typeId?: string) => readerHref(filterState, { type: typeId });
  const topicHref = (topic: string) => readerHref(filterState, { topic });
  const clearTopicHref = () => readerHref(filterState, { topic: undefined });
  const pageHref = (targetPage: number) => readerHref(filterState, { page: targetPage > 1 ? String(targetPage) : undefined });

  const historicalDescription = balancedOverview
    ? "跨平台均衡概览，避免站点榜单淹没公众号和搜索；完整历史可进入各平台查看。"
    : `${activeTab.label}历史内容，可按类型、主题和关键词回看。`;
  const showFeaturedTop = isFeaturedView && !search && !activeContentTypeId && !activeTopic;
  const featuredTop = showFeaturedTop ? feed.topItems : [];

  return (
    <main className="reader-page">
      {usingDemo && (
        <div className="demo-banner">
          {(isChangesView || isFollowedView) ? <>事件视图需要可用的数据库与事件记录。当前未展示真实事件，请检查连接和迁移。</> : <>演示数据：未连接数据库，配置 <code>DATABASE_URL</code> 后展示实时信息流。</>}
        </div>
      )}

      <section className="reader-hero">
        <div>
          <div className="eyebrow">
            <Sparkles size={14} /> {isFollowedView ? "持续回看已关注事件" : isChangesView ? "关注任务的新变化" : isFeaturedView ? "近期精选" : "今日信息流"}
          </div>
          <h1>{isFollowedView ? "已关注事件" : isChangesView ? "关注变化" : isFeaturedView ? "精选" : isLatestView ? "最新" : "全部信息"}</h1>
          <p>{isFollowedView ? "查看已关注事件，包括已读记录。持续关联支持有明确版本的开放状态与更正；关注不等于监控整个产品的所有动态。" : isChangesView ? "最近 14 天尚未读过的事件变化；首次使用显示已有事件，标记已读后只显示后续进展或原文修订。" : isFeaturedView ? "过去 3 天达到质量门槛的内容；重点先选，时间流按事件变化时间更新。" : isLatestView ? "近 24 小时的新动态，多平台持续更新。" : historicalDescription}</p>
        </div>
        <div className="hero-stat">
          <strong>{totalIsExact ? total : `≥${total}`}</strong>
          <span>{(isChangesView || isFeaturedView || isFollowedView) ? `当前 ${items.length} 个事件` : balancedOverview ? `已收录 · 当前展示 ${items.length}` : `已收录 · 第 ${page} 页`}</span>
        </div>
      </section>

      <FeaturedTop items={featuredTop} taskName={selectedRules.map(rule => rule.name).join(" + ") || undefined} />

      <section className="filter-panel" aria-label="信息筛选">
        <div className="filter-left">
          <div className="platform-tabs">
            {PLATFORM_TABS.map((t) => (
              <Link key={t.key} href={tabHref(t.key)} className={t.key === activeKey ? "active" : ""}>
                {t.label}
              </Link>
            ))}
          </div>
          {monitorFilters.length > 0 && (
            <div className="rule-tabs" aria-label="监控范围筛选">
              <Link href={monitorHref()} className={!selectedRules.length ? "active" : ""}>
                全部监控范围
              </Link>
              {monitorFilters.map((rule) => (
                <Link key={rule.id} href={monitorHref(rule.id)} className={selectedRules.length === 1 && selectedRules[0].id === rule.id ? "active" : ""}>
                  {rule.name}
                </Link>
              ))}
              <details className="monitor-combination">
                <summary>组合监控范围{selectedRules.length > 1 ? `（${selectedRules.length}项）` : ""}</summary>
                <form action="/" method="get">
                  {Object.entries(filterState).filter(([key]) => key !== "monitor").map(([key, value]) => value && <input key={key} type="hidden" name={key} value={value} />)}
                  <p>汇总选中监控的内容。具体关键词和排除条件在各监控中设置；排序偏好不会排除其它内容。</p>
                  {monitorFilters.map(rule => <label key={rule.id}><input type="checkbox" name="monitor" value={rule.id} defaultChecked={selectedMonitorIds.includes(rule.id)} />{rule.name}</label>)}
                  <button type="submit">应用范围</button>
                </form>
              </details>
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
          {isChangesView && <label className="followed-filter"><input type="checkbox" name="followed" value="1" defaultChecked={sp.followed === "1"} />只看已关注事件</label>}
          {isStreamView && <input type="hidden" name="view" value={readerMode} />}
          {selectedMonitorIds.map(id => <input key={id} type="hidden" name="monitor" value={id} />)}
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
              title={isFeaturedView ? "精选表示达到质量门槛，不代表每张卡片的名次；下方按事件变化时间倒序。" : undefined}
            >
              {group.weekday} · {group.items.length} {(isChangesView || isFeaturedView || isFollowedView) ? "个事件 · 按变化时间倒序" : "条"}
            </span>
            {index === 0 && <span>本页最新记录于 {latestRecord}</span>}
          </div>
          <section className="timeline" aria-label={`${group.label}信息时间线`}>
            {group.items.map((item) => <TimelineCard item={item} key={item.id} topicHref={topicHref} />)}
          </section>
        </div>
      )) : (
        <section className="timeline" aria-label="信息时间线">
          <div className="empty-state">
            {emptyPipeline?.available && <p>全库来源记录：{emptyPipeline.total} 条，自动分析待办 {emptyPipeline.analysisPending} 篇，未自动排队 {emptyPipeline.analysisUnqueued} 篇，理解失败 {emptyPipeline.analysisFailed} 条，变化待处理 {emptyPipeline.projectionPending} 条。<Link className="inline-link" href="/admin/connectors">查看处理状态</Link></p>}
            {feed.unavailable ? (
              <p>暂时无法读取内容，请稍后刷新；若持续出现，请到管理后台检查数据库连接与迁移状态。</p>
            ) : search ? (
              <p>未找到匹配“{search}”的信息。</p>
            ) : activeTopic ? (
              <p>暂无 #{activeTopic} 相关内容。可以清除主题标签，或等待后续采集。</p>
            ) : isFollowedView ? (
              <p>当前筛选下没有已关注事件。可以在事件卡片中点击“关注事件”，之后到这里回看。</p>
            ) : isChangesView ? (
              <p>当前筛选下没有未读变化。已读事件出现新进展或原文修订后会再次显示；首次使用可到“最新”核对采集结果。</p>
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
