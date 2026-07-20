# Content Pipeline Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a novice-friendly backend dashboard that shows whether content has been collected, whether WeChat full text is available, and whether summaries, classifications, and tags have been completed.

**Architecture:** Derive the first version entirely from existing `items`, `item_matches`, and `collection_runs` data so no database migration is required. Query only content still connected to at least one monitor, aggregate by platform, then render a read-only Server Component on the platform-connections page with clear status and action guidance.

**Tech Stack:** Next.js 16 App Router Server Components, TypeScript, Drizzle ORM, PostgreSQL, Vitest, CSS, Docker Compose.

---

### Task 1: Define pipeline statistics and product-state rules

**Files:**
- Create: `src/lib/content-pipeline.ts`
- Test: `tests/content-pipeline.test.ts`

**Steps:**
1. Define platform and recent-run aggregate input types.
2. Add a pure view-model builder that computes total content, missing summaries, WeChat missing full text, completion percentages, and user-facing attention messages.
3. Write tests for empty data, healthy data, missing WeChat full text, summary backlog, and failed recent runs.
4. Run `pnpm test tests/content-pipeline.test.ts` and confirm all cases pass.

### Task 2: Query live pipeline data

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/lib/content-pipeline.ts`

**Steps:**
1. Aggregate visible items by platform, counting non-empty summaries, complete classification/tag data, and WeChat full text.
2. Aggregate the last 24 hours of collection runs, including failed/partial runs and summary attempts/successes/failures.
3. Exclude orphaned items that no longer belong to any monitor so dashboard counts match the reader.
4. Add a safe loader that returns an unavailable state instead of breaking the admin page if the database is unreachable.

### Task 3: Build the dashboard interface

**Files:**
- Create: `src/components/admin-content-pipeline.tsx`
- Modify: `src/app/admin/connectors/page.tsx`
- Modify: `src/app/globals.css`

**Steps:**
1. Add a compact `内容处理状态` card below the connector status strip.
2. Show the processing path: active content, WeChat full text, model summaries, and classified/tagged content.
3. Show per-platform completion rows for X, WeChat, web search, and hotlist/RSS.
4. Show only actionable, plain-language attention messages; include empty and unavailable states.
5. Ensure responsive layout, visible focus treatment, sufficient contrast, and no jargon-only labels.

### Task 4: Validate and deploy

**Commands:**
- `pnpm test tests/content-pipeline.test.ts`
- `pnpm exec eslint src/lib/content-pipeline.ts src/db/queries.ts src/components/admin-content-pipeline.tsx src/app/admin/connectors/page.tsx`
- `pnpm run build`
- `docker compose up -d --build web`
- `curl -s --max-time 10 http://127.0.0.1:3000/api/health`

**Expected:** Tests, lint, and build pass; the web container is healthy; `/admin/connectors` renders live processing statistics without a schema migration.
