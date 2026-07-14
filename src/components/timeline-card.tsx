import Link from "next/link";
import { Bookmark } from "lucide-react";
import type { ReaderItem } from "@/lib/reader-data";

const platformLabel: Record<ReaderItem["platform"], string> = {
  x: "X",
  wechat: "微",
  web_search: "搜",
  trendradar: "热",
};

export function TimelineCard({ item, topicHref }: { item: ReaderItem; topicHref?: (tag: string) => string }) {
  const external = Boolean(item.url);
  return (
    <article className="timeline-item">
      <time className="timeline-time">{item.time}</time>
      <div className="item-card">
        <div className="item-meta">
          <span className={`source-icon ${item.platform}`}>{platformLabel[item.platform]}</span>
          <span className="source-name">{item.source}</span>
          {item.handle && <span>{item.handle}</span>}
          <span className="meta-spacer" />
          {item.score > 0 && <span className="score">{item.score}</span>}
          <button className="save-button" aria-label={`收藏 ${item.title}`}>
            <Bookmark size={15} />
          </button>
        </div>
        {external ? (
          <h2>
            <a className="item-title-link" href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
          </h2>
        ) : (
          <h2>{item.title}</h2>
        )}
        {item.excerpt && <p className="item-excerpt">{item.excerpt}</p>}
        <footer className="item-footer">
          {external && (
            <a className="read-original" href={item.url} target="_blank" rel="noopener noreferrer">
              阅读原文 →
            </a>
          )}
          <span className="footer-spacer" />
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
        </footer>
      </div>
    </article>
  );
}
