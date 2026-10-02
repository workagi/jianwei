import type { ReaderItem } from "@/lib/reader-data";

export function FeaturedTop({ items, taskName }: { items: ReaderItem[]; taskName?: string }) {
  if (items.length === 0) return null;
  return (
    <section className="featured-top" aria-labelledby="featured-top-title">
      <header>
        <div>
          <strong id="featured-top-title">{taskName ? `${taskName} · 范围重点` : "近期重点"} TOP {items.length}</strong>
          <span>{taskName ? "从选中监控的内容中按相关分与时效选择" : "从近期候选中按内容评分与时效选择"}</span>
        </div>
      </header>
      <div className="featured-top-grid">
        {items.map((item, index) => {
          const sourceCount = 1 + (item.relatedSources?.length ?? 0);
          return (
            <a className="featured-top-item" href={`#item-${item.eventId ?? item.id}`} key={item.eventId ?? item.id}>
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
