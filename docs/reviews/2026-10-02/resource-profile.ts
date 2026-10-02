// Diagnostic only: --seed writes constructed articles into a disposable database.
// Run with DATABASE_URL pointing to the dedicated resource-review PostgreSQL.
import { db, sql as client } from "../../../src/db";
import { items, eventItems } from "../../../src/db/schema";
import { getItems, getReaderItems } from "../../../src/db/queries";
import { loadReaderFeed } from "../../../src/lib/reader-data";
import { eq, desc, sql } from "drizzle-orm";

async function main() {
  globalThis.fetch = async () => { throw new Error("External fetch disabled for resource review"); };
  const mode = process.argv[2] ?? "featured";
  if (mode === "--seed") {
    if (process.env.RESOURCE_REVIEW_DISPOSABLE !== "1") throw new Error("Seed requires an explicitly disposable database");
    await client.unsafe(`
      insert into monitors (id, platform, connector_id, name, config) values
        ('10000000-0000-4000-8000-000000000001', 'wechat', '00000000-0000-0000-0000-000000000002', '资源测量构造监控', '{}');
      insert into items (platform, source_provider, upstream_id, canonical_url, title, body_text, content_html,
        content_hash, published_at, ai_summary, editorial_reason, information_value_score, analysis_status, content_type, topic_tags, content_fetch_status)
      select 'wechat', 'wechat_werss', 'resource-' || n, 'https://example.test/resource/' || n,
        '构造产品 ' || (n % 300) || ' 发布接口说明', repeat('这是用于资源测量的构造正文。', 500),
        '<p>' || repeat('这是用于资源测量的构造正文。', 1500) || '</p>', md5(n::text), now() - (n || ' seconds')::interval,
        '构造产品发布接口说明，开放范围和调用条件均有变化，请核对材料。', '接口开放范围与调用条件发生变化，提供了具体参数与使用说明。', 85, 'success', 'product_update', '["Agent"]', 'success'
      from generate_series(1, 2000) n;
      insert into source_items (item_id, platform, source_provider, upstream_id, source_url, raw_payload, published_at)
        select id, platform, source_provider, upstream_id, canonical_url, '{}', published_at from items;
      insert into item_matches (item_id, monitor_id, source_item_id, retention_status, relevance_score)
        select item_id, '10000000-0000-4000-8000-000000000001', id, 'kept', 85 from source_items;
      insert into content_events (id, title, rule_version, revision, activity_at)
        select ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '构造产品 ' || n, 'resource-fixture', 1, now() from generate_series(0, 299) n;
      insert into event_items (item_id, event_id, source_revision)
        select id, ('20000000-0000-4000-8000-' || lpad((substring(upstream_id from 10)::integer % 300)::text, 12, '0'))::uuid, 1 from items;
      analyze items; analyze source_items; analyze item_matches; analyze event_items;
    `);
    console.log(JSON.stringify({ seeded: 2000, provenance: "synthetic", events: 300 }));
    await client.end(); return;
  }
  const since = new Date(Date.now() - 3 * 86_400_000);
  const before = process.memoryUsage();
  let peakRss = before.rss, peakHeap = before.heapUsed;
  const sample = () => { const mem = process.memoryUsage(); peakRss = Math.max(peakRss, mem.rss); peakHeap = Math.max(peakHeap, mem.heapUsed); };
  const timer = setInterval(sample, 20);
  const start = performance.now();
  let result: Awaited<ReturnType<typeof getItems>> | Awaited<ReturnType<typeof loadReaderFeed>> | unknown[];
  if (mode === "items") result = await getItems({ platform: "wechat", featuredOnly: true, since, limit: 5000 });
  else if (mode === "reader-items") result = await getReaderItems({ platform: "wechat", featuredOnly: true, since, limit: 5000 });
  else if (mode === "textless-reference") {
    // Transfer/allocation reference, not a replacement for production filtering.
    result = await db.select({ id: items.id, title: items.title, summary: items.aiSummary, tags: items.topicTags,
      score: items.informationValueScore, bodyPreview: sql<string>`left(${items.bodyText}, 320)`,
      hasFullText: sql<boolean>`nullif(btrim(${items.contentHtml}), '') is not null`, eventId: eventItems.eventId })
      .from(items).leftJoin(eventItems, eq(eventItems.itemId, items.id)).orderBy(desc(items.publishedAt)).limit(5000);
  } else if (mode === "featured" || mode === "changes") result = await loadReaderFeed({ mode, platform: "wechat", since });
  else throw new Error("Modes: --seed, items, reader-items, textless-reference, featured, changes");
  const elapsedMs = performance.now() - start;
  sample(); clearInterval(timer);
  const [size] = await client`select count(*)::int as documents, sum(octet_length(body_text) + octet_length(content_html))::bigint as full_text_bytes from items`;
  const mib = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));
  console.log(JSON.stringify({ mode, elapsedMs: Math.round(elapsedMs), documents: size.documents,
    fullTextFixtureMiB: mib(Number(size.full_text_bytes)), returned: Array.isArray(result) ? result.length : result.items.length,
    rssBeforeMiB: mib(before.rss), peakRssMiB: mib(peakRss), peakHeapMiB: mib(peakHeap),
    processHighWaterRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
    provenance: "synthetic", realModelCalls: 0, upstreamCalls: 0,
  }));
  await client.end();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
