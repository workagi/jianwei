import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db, sql as client } from '../../../src/db/index.ts';
import { contentEvents, items, monitors } from '../../../src/db/schema.ts';
import { getReaderEventIds, getReaderItems } from '../../../src/db/queries.ts';
import { compactEventMembers, groupPersistedEvents } from '../../../src/lib/content-clustering.ts';
import { loadReaderFeed, mapRow } from '../../../src/lib/reader-data.ts';

assert.equal(process.env.RESOURCE_REVIEW_DISPOSABLE, '1', 'Requires an explicitly disposable database');
assert.equal((await db.select().from(monitors)).length, 0, 'Use a fresh review database');
const label = process.argv[2];
assert.ok(['before', 'after'].includes(label));
const prefix = randomUUID();
let monitorId, eventId, externalCalls = 0;
globalThis.fetch = () => { externalCalls++; throw new Error('External requests are forbidden in this probe'); };
try {
  const [monitor] = await db.insert(monitors).values({ platform: 'web_search', connectorId: '00000000-0000-0000-0000-000000000003',
    name: 'Reader list probe', config: {}, nextRunAt: new Date(Date.now() + 86400000) }).returning();
  monitorId = monitor.id;
  const [event] = await db.insert(contentEvents).values({ title: 'Repeated materials', ruleVersion: 'reader-probe', revision: 1, activityAt: new Date() }).returning();
  eventId = event.id;
  await db.execute(sql`insert into items (platform, upstream_id, canonical_url, title, body_text, content_html, content_hash, published_at, content_type, topic_tags, information_value_score, analysis_status)
    select 'web_search', ${prefix} || n, 'https://example.test/' || ${prefix} || n, 'Acme Agent 发布新功能', repeat('接口参数与使用条件。', 1500), repeat('<p>接口说明。</p>', 1500), md5(n::text), now(), 'product_update', '["Agent"]'::jsonb, 85, 'success'
    from generate_series(1, 20000) n`);
  await db.execute(sql`insert into source_items (item_id, platform, source_provider, upstream_id, source_url)
    select id, platform, 'web_brave', upstream_id, canonical_url from items where upstream_id like ${prefix + '%'}`);
  await db.execute(sql`insert into item_matches (item_id, monitor_id, source_item_id, retention_status, relevance_score)
    select item_id, ${monitorId}::uuid, id, 'kept', 85 from source_items where upstream_id like ${prefix + '%'}`);
  await db.execute(sql`insert into event_items (item_id, event_id, source_revision)
    select id, ${eventId}::uuid, 1 from items where upstream_id like ${prefix + '%'}`);
  for (const table of ['items', 'source_items', 'item_matches', 'event_items']) await db.execute(sql`analyze ${sql.identifier(table)}`);
  let selects = 0, displaySelects = 0;
  client.options.debug = (_connection, query) => {
    if (/^select/i.test(query)) selects++;
    if (query.includes('from "bookmarks"')) displaySelects++;
  };
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const start = performance.now();
  let feed;
  if (label === 'before') {
    // Reproduce the previous identity-window + full reader-projection scan on
    // this fixture (one event, no local gates). The shared query semantics are unchanged.
    const candidates = await getReaderEventIds({ monitorId, changesOnly: true }, 100, 0);
    assert.equal(candidates.length, 1);
    let afterId, members = [];
    for (;;) {
      const identities = await db.select({ id: items.id }).from(items).where(and(
        sql`exists (select 1 from item_matches im where im.item_id = ${items.id} and im.retention_status = 'kept')`,
        sql`exists (select 1 from item_matches im where im.item_id = ${items.id} and im.monitor_id = ${monitorId}::uuid and im.retention_status = 'kept')`,
        sql`exists (select 1 from event_items ei where ei.item_id = ${items.id} and ei.event_id = ${eventId}::uuid)`,
        afterId ? gt(items.id, afterId) : undefined,
      )).orderBy(asc(items.id)).limit(200);
      const rows = identities.length ? await getReaderItems({ monitorId, changesOnly: true, eventIds: [eventId], itemIds: identities.map(row => row.id) }) : [];
      members = compactEventMembers([...members, ...rows.map(mapRow)]);
      if (identities.length < 200) break;
      afterId = identities[identities.length - 1].id;
    }
    feed = { usingDemo: false, items: groupPersistedEvents(members) };
  } else feed = await loadReaderFeed({ mode: 'changes', monitorId });
  clearInterval(sampler);
  client.options.debug = undefined;
  assert.equal(feed.usingDemo, false); assert.equal(feed.items.length, 1); assert.equal(feed.items[0].eventId, eventId);
  assert.equal(externalCalls, 0);
  const report = { scope: 'Isolated PostgreSQL 17, 1 CPU / 512 MiB; constructed repeated materials; no production or upstream access',
    label, materials: 20000, cards: feed.items.length, elapsedMs: Math.round(performance.now() - start),
    sampledWholeProbeRssMiB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576 * 100) / 100,
    selects, displaySelects, externalCalls, note: 'RSS includes fixture setup. Before reproduces the old scan without final evidence queries; after includes page hydration/evidence. One run per variant, not HTTP capacity certification.' };
  await writeFile(`docs/reviews/2026-10-03/reader-list-${label}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.options.debug = undefined;
  if (monitorId) await db.delete(monitors).where(eq(monitors.id, monitorId));
  await db.execute(sql`delete from items where upstream_id like ${prefix + '%'}`);
  if (eventId) await db.delete(contentEvents).where(eq(contentEvents.id, eventId));
  await client.end({ timeout: 5 });
}
