import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { loadEventDetail } from "@/lib/event-reader";
import { EventControls } from "@/components/event-controls";

export const dynamic = "force-dynamic";

export default async function EventPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ before?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { before } = await searchParams;
  const cursor = Number(before);
  const event = await loadEventDetail(id, Number.isSafeInteger(cursor) && cursor > 0 ? cursor : undefined);
  if (!event) notFound();
  const oldest = Math.max(event.before - 3, 1);
  return <main className="reader-page">
    <Link className="inline-link" href="/?view=followed">返回已关注事件</Link>
    <section className="reader-hero"><div><div className="eyebrow">事件记录</div><h1>{event.title}</h1>
      <p>当前第 {event.revision} 版，已读到第 {event.readRevision ?? 0} 版。按版本保留原文证据；全部标记已读会跳过所有剩余变化。</p>
      <p>持续关联支持有明确产品版本的开放状态与更正；其它关系按近期事件规则处理。</p>
      <EventControls eventId={id} revision={event.revision} readRevision={event.readRevision ?? 0} followed={Boolean(event.followed)} />
    </div></section>
    <section className="event-developments" aria-label="变化记录">
      {event.developments.map(d => <article className="item-card" key={d.id}>
        <small>第 {d.revision} 版 · {new Date(d.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small>
        <h2>{d.title}</h2><p>{d.label}</p><blockquote>{d.evidence}</blockquote>
        {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer">核对原文 ↗</a>}
      </article>)}
      {!event.developments.length && <p>这些版本暂无保存的原文证据。</p>}
    </section>
    <nav className="reader-pagination" aria-label="变化历史分页">
      {event.before < event.revision + 1 ? <Link href={`/events/${id}`}>查看最新变化</Link> : <span />}
      {oldest > 1 && <Link href={`/events/${id}?before=${oldest}`}>更早变化</Link>}
    </nav>
  </main>;
}
