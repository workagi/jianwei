import Link from "next/link";
import Image from "next/image";
import type { ReaderItem } from "@/lib/reader-data";
import { BookmarkButton } from "@/components/bookmark-button";

function sourceInitial(source: string): string {
  return source.trim().slice(0, 1).toUpperCase() || "·";
}

export function TimelineCard({ item, topicHref }: { item: ReaderItem; topicHref?: (tag: string) => string }) {
  const external = Boolean(item.url);
  const sameAsPrimary = item.excerpt.trim().replace(/\s+/g, " ") === item.title.trim().replace(/\s+/g, " ");
  const hasTopics = item.tags.length > 0 || Boolean(item.match);
  return (
    <article className="timeline-item" id={`item-${item.id}`}>
      <time className="timeline-time">{item.time}</time>
      <div className="item-card">
        <div className="item-meta">
          {item.sourceKind === "x" ? (
            <span className="source-avatar" aria-hidden="true">
              <span>{sourceInitial(item.source)}</span>
              {item.avatarUrl && (
                <Image
                  src={item.avatarUrl}
                  alt=""
                  width={32}
                  height={32}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  unoptimized
                />
              )}
            </span>
          ) : null}
          <span className="source-name">
            {item.sourceKind === "wechat" ? `公众号：${item.source}` : item.sourceKind === "web" ? `网页：${item.source}` : item.source}
          </span>
          {item.sourceKind === "x" && item.handle && <span className="source-handle">@{item.handle.replace(/^@/, "")}</span>}
          {item.sourceKind === "rss" && <span className="source-kind-label">RSS</span>}
          {item.sourceKind === "hotlist" && (
            <span className="source-kind-label" title="来自该网站公开榜单，不代表见微推荐排序">
              站点榜单
            </span>
          )}
          {item.statusBadge && item.statusBadge.tone !== "ok" && (
            <span className={`item-status-badge ${item.statusBadge.tone}`} title={item.statusBadge.title}>
              {item.statusBadge.label}
            </span>
          )}
          <span className="meta-spacer" />
          {item.score > 0 && (
            <span className="score" title={`内容相关性与信息价值评分 ${item.score}/100`}>
              <span aria-hidden="true">•</span>
              {item.score}
            </span>
          )}
          <BookmarkButton itemId={item.id} title={item.title} initialBookmarked={item.bookmarked} />
        </div>
        {item.platform === "x" ? (
          <div className="x-post-body">
            <p className="x-post-content">
              {external ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
              ) : (
                item.title
              )}
            </p>
            {item.quote && (
              <aside className="x-quote-card" aria-label="引用的推文">
                <div className="x-quote-meta">
                  <strong>{item.quote.author}</strong>
                  {item.quote.handle && <span>@{item.quote.handle.replace(/^@/, "")}</span>}
                </div>
                {item.quote.url ? (
                  <a className="x-quote-text" href={item.quote.url} target="_blank" rel="noopener noreferrer">
                    {item.quote.text}
                  </a>
                ) : (
                  <p className="x-quote-text">{item.quote.text}</p>
                )}
              </aside>
            )}
          </div>
        ) : external ? (
          <h2>
            <a className="item-title-link" href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
          </h2>
        ) : (
          <h2>{item.title}</h2>
        )}
        {item.excerpt && !sameAsPrimary && <p className="item-excerpt">{item.excerpt}</p>}
        {hasTopics && (
          <div className="item-tags" aria-label="内容标签">
            {item.tags.map((tag) => (
              topicHref ? (
                <Link className="tag" href={topicHref(tag)} key={tag} title={`查看 #${tag} 相关内容`}>
                  #{tag}
                </Link>
              ) : (
                <span className="tag" key={tag}>
                  #{tag}
                </span>
              )
            ))}
            {item.match && <span className="match-reason">{item.match}</span>}
          </div>
        )}
        {item.relatedSources && item.relatedSources.length > 0 && (
          <div className="related-sources" aria-label="同一事件的其他信源">
            <strong>另有 {item.relatedSources.length} 个信源</strong>
            <div>
              {item.relatedSources.slice(0, 4).map((source) => (
                source.url ? (
                  <a href={source.url} key={`${source.platform}:${source.source}`} target="_blank" rel="noopener noreferrer" title={source.title}>
                    {source.source}
                  </a>
                ) : (
                  <span key={`${source.platform}:${source.source}`} title={source.title}>{source.source}</span>
                )
              ))}
              {item.relatedSources.length > 4 && <span>+{item.relatedSources.length - 4}</span>}
            </div>
          </div>
        )}
        {item.whyKept ? (
          <footer className="recommendation-reason">
            <p><strong>推荐理由：</strong>{item.whyKept}</p>
            {external && (
              <a className="read-original" href={item.url} target="_blank" rel="noopener noreferrer">
                查看原文 ↗
              </a>
            )}
          </footer>
        ) : external ? (
          <footer className="item-footer item-footer-quiet">
            <a className="read-original" href={item.url} target="_blank" rel="noopener noreferrer">
              查看原文 ↗
            </a>
          </footer>
        ) : null}
      </div>
    </article>
  );
}
