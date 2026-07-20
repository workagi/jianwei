import Link from "next/link";
import { TimelineCard } from "@/components/timeline-card";
import { loadBookmarkedFeed } from "@/lib/reader-data";

export const dynamic = "force-dynamic";

export default async function StarredPage() {
  const { items, total } = await loadBookmarkedFeed();
  return (
    <main className="reader-page">
      <section className="reader-hero">
        <div>
          <div className="eyebrow">收藏</div>
          <h1>我的收藏</h1>
          <p>把稍后要精读、复盘或用于选题的内容集中放在这里。</p>
        </div>
        <div className="hero-stat"><strong>{total}</strong><span>已收藏</span></div>
      </section>
      {items.length > 0 ? (
        <section className="timeline" aria-label="收藏内容时间线">
          {items.map((item) => (
            <TimelineCard
              key={item.id}
              item={item}
              topicHref={(tag) => `/?topic=${encodeURIComponent(tag)}`}
            />
          ))}
        </section>
      ) : (
        <div className="empty-state">
          <p>
            还没有收藏内容。先去 <Link href="/" className="inline-link">最新信息流</Link>，点击卡片右上角书签。
          </p>
        </div>
      )}
    </main>
  );
}
