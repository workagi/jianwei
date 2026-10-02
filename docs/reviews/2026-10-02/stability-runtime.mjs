// Run only against a freshly migrated disposable database. No real upstream/model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { db, sql as client } from '../../../src/db/index.ts';
import { items, monitors, eventItems, contentEvents, modelReceipts, modelAttempts, documentAnalysisClaims } from '../../../src/db/schema.ts';
import { createDrizzleIngestRepository, prepareIngest, commitPreparedIngest } from '../../../src/ingestion/ingest-items.ts';
import { canonicalUrlHash } from '../../../src/ingestion/repositories.ts';
import { loadReaderFeed } from '../../../src/lib/reader-data.ts';
import { pruneOperationalHistory } from '../../../src/worker/maintenance.ts';

assert.equal(process.env.RESOURCE_REVIEW_DISPOSABLE, '1', 'Only use an explicitly disposable database');
assert.equal((await db.select().from(monitors)).length, 0, 'Probe expects no existing monitors');
const prefix = `stability-${randomUUID()}`;
const report = { scope: 'Isolated PostgreSQL 17 (1 CPU / 512MiB), constructed data, local fake model only; not long-term production certification', realModelCalls: 0, upstreamCalls: 0 };
const children = [];
let calls = 0, receiptKey, monitorId, eventId;
const server = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  calls++;
  const content = { summary: 'Acme Agent 2.0 开放 API，文档明确列出了接口参数与使用条件。', content_type: 'product_update', topic_tags: ['Agent', 'API'], relevance_score: 90,
    keep_reason: 'Acme Agent 2.0 新增公开接口并列出使用条件，开发者可据此核对现有调用方式。' };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const modelEnv = { SUMMARY_PROVIDER: 'custom', SUMMARY_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, SUMMARY_API_KEY: 'local-fixture-placeholder', SUMMARY_MODEL: 'stability-model', SUMMARY_SKIP_PLATFORMS: '', SUMMARY_REQUESTS_PER_MINUTE: '0', MODEL_DAILY_REQUEST_LIMIT: '1000' };
Object.assign(process.env, modelEnv);
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
  throw new Error(message);
}
function worker() {
  const process_ = spawn(process.execPath, ['dist/worker/index.js'], { cwd: process.cwd(), env: { ...process.env, ...modelEnv, NODE_ENV: 'production', WORKER_POLL_INTERVAL_SECONDS: '5' }, stdio: 'ignore' });
  children.push(process_); return process_;
}
async function stop(process_, signal = 'SIGTERM') {
  if (process_.exitCode !== null || process_.signalCode !== null) return;
  const exited = once(process_, 'exit'); process_.kill(signal); await exited;
}
try {
  const [monitor] = await db.insert(monitors).values({ platform: 'web_search', connectorId: '00000000-0000-0000-0000-000000000003', name: prefix, config: {}, nextRunAt: new Date(Date.now() + 86400000) }).returning();
  monitorId = monitor.id;
  const input = { platform: 'web_search', sourceProvider: 'web_brave', upstreamId: prefix, canonicalUrl: `https://example.test/${prefix}`, title: 'Acme Agent 2.0 正式开放 API', text: `接口文档给出了调用参数与公开使用条件。${prefix}`, imageUrls: [], publishedAt: new Date(), raw: {} };
  const prepared = await prepareIngest(createDrizzleIngestRepository(), { items: [input], monitorId, deferAnalysis: true });
  await db.transaction(tx => commitPreparedIngest(createDrizzleIngestRepository(tx), prepared));
  const [original] = await db.select().from(items).where(eq(items.upstreamId, prefix));
  // Hold only the result-commit row: the model receipt can finish, but analysis cannot commit.
  await db.transaction(async tx => {
    await tx.select().from(items).where(eq(items.id, original.id)).for('update');
    const first = worker();
    await until(async () => {
      const [receipt] = await db.select().from(modelReceipts).where(eq(modelReceipts.model, 'stability-model'));
      if (receipt?.status === 'received') { receiptKey = receipt.key; return true; }
      return false;
    }, 'worker did not persist the local model response');
    await stop(first, 'SIGKILL');
  });
  const [afterCrash] = await db.select().from(items).where(eq(items.id, original.id));
  assert.equal(afterCrash.analysisStatus, 'pending'); assert.equal(afterCrash.bodyText, input.text);
  // Advance only this disposable claim's expiry; production recovery waits for its 30-minute lease.
  await db.update(documentAnalysisClaims).set({ expiresAt: new Date(0) }).where(eq(documentAnalysisClaims.canonicalUrlHash, canonicalUrlHash(input.canonicalUrl)));
  const second = worker();
  await until(async () => (await db.select().from(items).where(eq(items.id, original.id)))[0]?.analysisStatus === 'success', 'restarted worker did not reuse the response');
  await until(async () => (await db.select().from(eventItems).where(eq(eventItems.itemId, original.id))).length === 1, 'restarted worker did not project the event');
  await stop(second);
  const [membership] = await db.select().from(eventItems).where(eq(eventItems.itemId, original.id)); eventId = membership.eventId;
  const attempts = await db.select().from(modelAttempts).where(eq(modelAttempts.receiptKey, receiptKey));
  assert.equal(calls, 1); assert.equal(attempts.length, 1);
  report.crashRecovery = { forcedSignal: 'SIGKILL', checkpoint: 'paid response received, before analysis commit', originalPreserved: true, recoveredStatus: 'success', localModelHttpRequests: calls, durableAttempts: attempts.length, leaseExpiryAdvancedInFixture: true, productionLeaseMinutes: 30 };
  process.env.SUMMARY_PROVIDER = '';
  await db.delete(items).where(eq(items.id, original.id));
  await db.delete(contentEvents).where(eq(contentEvents.id, eventId)); eventId = undefined;

  const [event] = await db.insert(contentEvents).values({ title: '大事件重复材料', ruleVersion: 'stability-probe', revision: 1, activityAt: new Date() }).returning(); eventId = event.id;
  await db.execute(sql`insert into items (platform, upstream_id, canonical_url, title, body_text, content_html, content_hash, published_at, content_type, topic_tags, information_value_score, analysis_status)
    select 'web_search', ${prefix} || n, 'https://example.test/' || ${prefix} || n, 'Acme Agent 发布新功能', repeat('接口参数与使用条件。', 1500), repeat('<p>接口说明。</p>', 1500), md5(n::text), now(), 'product_update', '["Agent"]'::jsonb, 85, 'success'
    from generate_series(1, 20000) n`);
  await db.execute(sql`insert into source_items (item_id, platform, source_provider, upstream_id, source_url)
    select id, platform, 'web_brave', upstream_id, canonical_url from items where upstream_id like ${prefix + '%'}`);
  await db.execute(sql`insert into item_matches (item_id, monitor_id, source_item_id, retention_status, relevance_score)
    select item_id, ${monitorId}::uuid, id, 'kept', 85 from source_items where upstream_id like ${prefix + '%'}`);
  await db.execute(sql`insert into event_items (item_id, event_id, source_revision)
    select id, ${eventId}::uuid, 1 from items where upstream_id like ${prefix + '%'}`);
  await db.execute(sql`analyze items`); await db.execute(sql`analyze source_items`);
  await db.execute(sql`analyze item_matches`); await db.execute(sql`analyze event_items`);
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const started = performance.now();
  const feed = await loadReaderFeed({ mode: 'changes', monitorId });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  assert.equal(feed.items.length, 1); assert.equal(feed.items[0].eventId, eventId); assert.equal(feed.usingDemo, false);
  report.largeEvent = { constructedMaterials: 20000, memberBatchSize: 200, readerElapsedMs: Math.round(performance.now() - started), sampledWholeProbeRssMiB: Math.round(peak / 1048576 * 100) / 100, cards: feed.items.length, note: 'RSS includes probe setup/crash-recovery; not an isolated HTTP server baseline or source-count capacity limit' };

  await db.execute(sql`insert into collection_runs (monitor_id, scheduled_for, idempotency_key, started_at, finished_at, status)
    select ${monitorId}::uuid, now() - interval '40 days', gen_random_uuid()::text, now() - interval '40 days', now() - interval '40 days', 'success' from generate_series(1, 10000)`);
  const times = [], counts = [];
  for (;;) {
    const at = performance.now(); const result = await pruneOperationalHistory();
    times.push(Math.round((performance.now() - at) * 100) / 100); counts.push(result.collectionRuns);
    if (result.collectionRuns < 1000) break;
  }
  assert.equal(counts.reduce((a, b) => a + b, 0), 10000);
  report.history = { expiredRuns: 10000, batchSizes: counts, elapsedMsPerPass: times, maxElapsedMs: Math.max(...times), modelReceiptPreserved: (await db.select().from(modelReceipts).where(eq(modelReceipts.key, receiptKey))).length === 1 };
  await writeFile('docs/reviews/2026-10-02/stability-runtime-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const process_ of children) await stop(process_, 'SIGKILL');
  server.close();
  if (monitorId) await db.delete(monitors).where(eq(monitors.id, monitorId));
  await db.execute(sql`delete from items where upstream_id like ${prefix + '%'}`);
  if (eventId) await db.delete(contentEvents).where(eq(contentEvents.id, eventId));
  if (receiptKey) { await db.delete(modelAttempts).where(eq(modelAttempts.receiptKey, receiptKey)); await db.delete(modelReceipts).where(eq(modelReceipts.key, receiptKey)); }
  await client.end({ timeout: 5 });
}
