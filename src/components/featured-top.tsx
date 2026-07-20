import type { ReaderItem } from "@/lib/reader-data";

export function FeaturedTop({ items }: { items: ReaderItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="featured-top" aria-labelledby="featured-top-title">
      <header>
        <div>
          <strong id="featured-top-title">今日重点 TOP {items.length}</strong>
          <span>综合信息价值、时效性与多源佐证</span>
        </div>
      </header>
      <div className="featured-top-grid">
        {items.map((item, index) => {
          const sourceCount = 1 + (item.relatedSources?.length ?? 0);
          return (
            <a className="featured-top-item" href={`#item-${item.id}`} key={item.id}>
              <span className={`featured-rank rank-${index + 1}`}>{index + 1}</span>
              <span className="featured-top-copy">
                <strong>{item.title}</strong>
                <small>
                  {item.source} · {sourceCount > 1 ? `${sourceCount} 个信源` : item.contentTypeLabel} · {item.score} 分
                </small>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
