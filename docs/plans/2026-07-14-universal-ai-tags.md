# Universal AI Tags Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn SignalDeck filtering into a durable source + content type + topic tag system, with local fallback classification and AI-generated tags persisted on new items.

**Architecture:** Keep platform/source as the first filter. Use one primary `content_type` per item for top-level filtering, and multiple `topic_tags` for card-level discovery. Local rules provide deterministic fallback; the summary model may return structured JSON to improve accuracy when enabled.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle ORM, Postgres JSONB, Vitest, Docker Compose.

---

### Task 1: Reshape tag taxonomy

**Files:**
- Modify: `src/lib/item-tags.ts`
- Test: `tests/item-tags.test.ts`

**Steps:**
1. Replace mixed top-level tags with content types: product update, model release, industry business, research, tutorial, policy safety, opinion.
2. Move Agent, multimodal, OpenAI, DeepSeek, MCP, financing, open source, Prompt, etc. into topic tags.
3. Add normalization helpers for AI output.
4. Update tests to prove one item can have one content type and multiple topic tags.

### Task 2: Persist classification

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0004_*.sql`
- Modify: `src/ingestion/ingest-items.ts`

**Steps:**
1. Add `items.content_type text` and `items.topic_tags jsonb not null default []`.
2. Fill local rule classification during ingest.
3. Preserve/update the columns on upsert.
4. Keep reader fallback for existing rows.

### Task 3: Let AI summary produce structured labels

**Files:**
- Modify: `src/lib/summarizer.ts`
- Modify: `src/ingestion/ingest-items.ts`
- Test: `tests/summarizer.test.ts`, `tests/ingest-items.test.ts`

**Steps:**
1. Ask providers for JSON containing `summary`, `content_type`, and `topic_tags`.
2. Parse JSON if possible, fall back to plain summary for compatibility.
3. Apply AI classification only for new items and never block ingestion.

### Task 4: Update reader UI and filtering

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/lib/reader-data.ts`
- Modify: `src/app/globals.css`

**Steps:**
1. Rename the top row from loose labels to `内容类型`.
2. Use `type=` URL parameter for content type; support old `tag=` links as a compatibility fallback.
3. Render card footer topic tags from persisted/fallback topic tags.

### Task 5: Validate and deploy

**Commands:**
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `docker compose build web worker`
- `docker compose up -d web worker`
- Fetch `/`, `/?type=policy_safety`, and `/?platform=wechat&type=tutorial` inside the web container.
