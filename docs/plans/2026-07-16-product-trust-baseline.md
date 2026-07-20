# Product Trust Baseline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make SignalDeck's reader counts, deletion behavior, bookmarks, and service status match what the product tells the user.

**Architecture:** Keep the existing single-user Next.js/Postgres architecture. Add durable bookmark and runtime-heartbeat tables, expose small authenticated mutation APIs, and keep feed pagination server-rendered through URL parameters. Monitor deletion becomes archive-by-default so history remains visible; explicit history deletion keeps the current hard-delete behavior.

**Tech Stack:** Next.js 16 App Router, React 19, Drizzle ORM, PostgreSQL, Vitest, Docker Compose.

---

### Task 1: Feed totals and pagination

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/lib/reader-data.ts`
- Modify: `src/app/page.tsx`
- Test: `tests/reader-data.test.ts`

1. Add a database count query that shares the platform/search/monitor/time conditions with the feed query.
2. Extend `loadReaderFeed` with page/page-size metadata and preserve platform balancing for the unified feed.
3. Replace the misleading “完整历史库 / 当前条目” copy with total/current-page wording and add previous/next links.
4. Add tests for page bounds, metadata, and query-parameter preservation.

### Task 2: Safe monitor removal

**Files:**
- Modify: `src/app/api/monitors/[id]/route.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/components/monitor-list.tsx`
- Test: `tests/monitor-delete.test.ts`

1. Archive monitors by default by disabling them and recording `_archivedAt` in config; keep item matches so historical content stays readable.
2. Hard-delete the monitor and orphaned content only when `deleteItems=1` is explicitly requested.
3. Make the confirmation UI clearly distinguish “remove task, keep history” from “also delete exclusive history”.
4. Keep the independent WeRSS unsubscribe option and cover combinations in tests.

### Task 3: Durable bookmarks

**Files:**
- Create: `drizzle/0009_product_trust_baseline.sql`
- Modify: `src/db/schema.ts`
- Modify: `src/db/queries.ts`
- Create: `src/app/api/bookmarks/route.ts`
- Create: `src/components/bookmark-button.tsx`
- Modify: `src/components/timeline-card.tsx`
- Modify: `src/app/starred/page.tsx`
- Test: `tests/bookmarks.test.ts`

1. Add a single-user `bookmarks` table keyed by item ID.
2. Include bookmark state in reader rows and add authenticated add/remove APIs.
3. Replace the dead icon with an optimistic, accessible client button.
4. Render real bookmarked cards on `/starred` and remove “即将上线”.

### Task 4: Real service health

**Files:**
- Modify: `drizzle/0009_product-trust-baseline.sql`
- Modify: `src/db/schema.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/app/api/health/route.ts`
- Create: `src/components/system-status.tsx`
- Modify: `src/components/sidebar.tsx`
- Test: `tests/system-health.test.ts`

1. Add a `runtime_health` table and upsert the worker heartbeat every poll cycle.
2. Make `/api/health` report database and worker freshness separately.
3. Replace the hard-coded green sidebar state with a polling status component that shows running, delayed, or unavailable.
4. Keep Docker health checks compatible with startup ordering.

### Task 5: Verification and deployment

**Files:**
- Modify: `docs/production-deploy.md`

1. Run the focused tests after each task, then the complete test suite, lint, and production build.
2. Apply migrations to the current local Postgres instance.
3. Rebuild/restart the web and worker containers and verify feed pagination, bookmark persistence, deletion copy, and live worker state in the browser.
4. Document bookmark/runtime-health backup coverage and the enhanced WeChat collector volume.

