# WeChat Full-Text Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover more WeChat article bodies when WeRSS cannot return full text, persist which channel succeeded, and make the behavior configurable and observable from the backend.

**Architecture:** Keep WeRSS as the subscription and primary full-text source. Add a small full-text resolver chain with a credential-free direct public-article parser and an optional `wechat-download-api` endpoint; persist result status/provider on each item and reuse the same chain for new collection and old-content backfill. Do not start or require a second login-based service by default.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM, PostgreSQL, Vitest, Docker Compose, native Fetch API.

---

### Task 1: Build and test the resolver chain

**Files:**
- Create: `src/connectors/wechat/full-text-resolver.ts`
- Test: `tests/wechat-full-text-resolver.test.ts`

**Steps:**
1. Parse the balanced `#js_content` body from a public WeChat article page and reject verification/challenge pages.
2. Implement the optional `POST /api/article` contract used by `tmwgsicp/wechat-download-api`.
3. Run sources in order: WeRSS primary, direct public-page parser, optional enhanced fallback API.
4. Return structured success/failure metadata without leaking response bodies or credentials.
5. Test primary success, direct fallback success, API fallback success, malformed responses, and total failure.

### Task 2: Persist full-text provenance and failure state

**Files:**
- Modify: `src/connectors/types.ts`
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0005_*.sql` and matching metadata
- Modify: `src/ingestion/ingest-items.ts`
- Test: `tests/ingest-items.test.ts`

**Steps:**
1. Add `content_provider`, `content_fetch_status`, `content_fetch_error`, and `content_fetched_at` to items.
2. Pass resolver metadata through `NormalizedItem` into storage.
3. Preserve an existing full body during later list-only upserts instead of overwriting it with null.
4. Add tests proving metadata persistence and full-text preservation behavior.

### Task 3: Wire fallback into collection and backfill

**Files:**
- Modify: `src/connectors/wechat/werss-connector.ts`
- Modify: `src/connectors/factory.ts`
- Modify: `src/lib/summary-backfill.ts`
- Modify: `src/worker/index.ts`
- Test: `tests/werss-connector.test.ts`

**Steps:**
1. Replace the silent WeRSS-only body fetch with the resolver chain.
2. Mark each new WeChat item as success or failed and record the successful provider.
3. Reuse the same result in old-content backfill and persist the metadata.
4. Refresh fallback settings in the worker without restart.

### Task 4: Add backend configuration and manual recovery

**Files:**
- Create: `src/app/api/settings/wechat-content/route.ts`
- Create: `src/components/admin-wechat-content.tsx`
- Create: `src/lib/wechat-content-backfill.ts`
- Modify: `src/app/admin/connectors/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Steps:**
1. Explain the three channels in plain Chinese and show which are active.
2. Let the user enable/disable credential-free direct fallback and optionally save a `wechat-download-api` Base URL.
3. Add a small-batch “retry missing full text” action with provider-level success counts.
4. Add an optional Docker Compose profile for `wechat-download-api`; keep it disabled by default because it needs a separate public-platform login.
5. Validate URLs and keep the optional HTTP API bound to localhost when enabled.

### Task 5: Surface provenance in reader and pipeline dashboard

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/lib/reader-data.ts`
- Modify: `src/lib/content-pipeline.ts`
- Modify: `src/components/admin-content-pipeline.tsx`
- Test: `tests/content-pipeline.test.ts`

**Steps:**
1. Display `备用全文` when direct/API fallback recovered the body.
2. Display `全文失败` when all configured body channels failed.
3. Add fallback-recovered and failed counts to the processing dashboard.
4. Keep old rows compatible when they do not have provenance metadata yet.

### Task 6: Validate and deploy

**Commands:**
- `pnpm test tests/wechat-full-text-resolver.test.ts tests/werss-connector.test.ts tests/ingest-items.test.ts tests/content-pipeline.test.ts`
- `pnpm exec eslint <changed TypeScript files>`
- `pnpm run build`
- `docker compose up -d --build migrate web worker`
- Verify authenticated `/admin/connectors`, `/api/health`, and worker health.

**Expected:** Existing WeRSS behavior remains intact; direct fallback is active without another login; optional enhanced fallback stays off until configured; old missing bodies can be retried from the backend; provider and failure state are visible in both reader cards and processing statistics.
