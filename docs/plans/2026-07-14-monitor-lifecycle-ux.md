# Monitor Lifecycle UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make monitor creation, collection, and health understandable to a non-technical user, especially for WeChat/WeRSS sources.

**Architecture:** Treat a monitor as a lifecycle, not a single row with a vague health label. The UI should derive a human-readable status from three layers: external source readiness, collection run state, and content availability. WeChat creation must either fully subscribe the WeRSS feed or clearly fail before creating a misleading monitor.

**Global product rule:** A reader can only trust the feed if two invariants hold:

1. The displayed time must never be in the future relative to the user's current timezone unless the source explicitly represents a scheduled future event.
2. User-managed monitors and system-managed sidecars must be visibly different; users should not be offered controls that cannot actually change the real upstream source of truth.

**Tech Stack:** Next.js App Router, React client components, Drizzle/Postgres, Docker Compose worker, WeRSS sidecar.

---

## Desired Product Experience

A novice user does not want to know what `mpId`, `mpBiz`, `cursor`, or `collection_runs` mean. They want to answer four questions quickly:

1. Did I add the right source?
2. Is the source actually connected?
3. Has the system collected anything yet?
4. If it is not working, what exactly should I do next?

For WeChat, the ideal flow is:

1. Paste any public WeChat article URL.
2. Click "Verify".
3. See account identity: name, avatar, article sample, and WeRSS subscription readiness.
4. Click "Save".
5. See "Subscribed in WeRSS, first collection queued".
6. After worker runs, see "Collected 25 articles, latest at ...".
7. If summary is enabled but rate-limited, see "Collection OK, summary rate-limited".

The user should never see a monitor marked "Normal" if the external subscription failed or if first collection produced no content.

## Product State Model

Use these labels in the admin UI:

- `待验证`: The user has not validated the source yet.
- `可保存`: The source identity is resolved and required external setup is ready.
- `订阅失败`: External source subscription failed; do not silently create a "normal" monitor.
- `待首次采集`: Monitor exists and is queued, but no successful run with content yet.
- `采集中`: Latest run is active and not stale.
- `采集中断`: Latest run is still marked running after the worker timeout window.
- `正常`: Latest completed run succeeded and content exists.
- `暂无新内容`: Latest completed run succeeded but fetched zero new items after an earlier success.
- `首次无内容`: First completed run fetched zero items; user should inspect the source/subscription.
- `需要授权`: Credentials or WeRSS auth failed.
- `限流`: Provider rate limit, including summary model rate limit.
- `失败`: Other actionable failure.

## Task 1: Stop misleading WeChat saves

**Files:**
- Modify: `src/app/api/monitors/route.ts`
- Modify: `src/app/api/monitors/[id]/route.ts`
- Test: `tests/monitors-api.test.ts` or existing route-level test file if present.

**Behavior:**
- Creating a WeChat monitor must not ignore WeRSS subscription errors.
- If WeRSS subscribe fails, return non-2xx with a clear Chinese message.
- Editing a WeChat URL must not silently keep the old subscription if the new subscription fails.
- Keep non-WeChat platforms unchanged.

**Acceptance criteria:**
- Bad/unauthorized WeRSS does not create a local WeChat monitor.
- A successful WeChat create stores `mpId`, `mpBiz`, `mpName`, `mpCover`, and `mpIntro` when available.
- The UI error says what to do next, e.g. "WeRSS 订阅失败，请检查 Access Key / 扫码授权后重试".

## Task 2: Preserve WeChat metadata on edit

**Files:**
- Modify: `src/components/monitor-wizard.tsx`
- Modify: `src/app/api/monitors/[id]/route.ts`
- Test: `tests/monitors-api.test.ts` or component-level test if available.

**Behavior:**
- Editing frequency or display name must not wipe stored WeChat metadata.
- If the URL does not change, merge existing config with parsed patch config.
- If the URL changes, re-resolve and replace WeChat metadata.

**Acceptance criteria:**
- Edit a WeChat monitor frequency; DB still has `mpId/mpBiz/mpName`.
- Edit a WeChat URL; DB has the new account identity.

## Task 3: Add admin status view model

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/lib/reader-data.ts`
- Modify: `src/components/monitor-list.tsx`
- Modify: `src/app/admin/page.tsx`
- Test: `tests/reader-data.test.ts` or new unit test for status derivation.

**Behavior:**
- Admin list should show a primary status and a secondary detail line.
- Derive status from monitor row, latest collection run, item count, and credential/source hints.
- Do not expose raw internal errors by default; show a short action-oriented message.

**Acceptance criteria:**
- A monitor with no success and no items shows `待首次采集`.
- A stale running run shows `采集中断`.
- A latest failed run with 401/403 shows `需要授权`.
- A successful run with items shows `正常 · 已采集 N 篇`.
- Summary 429 is shown as a secondary warning, not as collection failure.

## Task 4: Clean stale running runs

**Files:**
- Modify: `src/worker/index.ts`
- Test: `tests/worker-dispatch.test.ts` or new worker lifecycle test.

**Behavior:**
- On worker startup, mark stale `collection_runs.status = running` as failed/interrupted if `started_at` is older than the gather timeout window.
- The monitor itself should not be marked failed if a later successful run exists.

**Acceptance criteria:**
- Restarting worker after an interrupted run does not leave permanent `running` rows.
- Admin UI can distinguish "interrupted history" from current monitor health.

## Task 5: Split collection status from summary status

**Status:** Implemented on 2026-07-14.

**Files:**
- Modify: `src/ingestion/ingest-items.ts`
- Modify: `src/lib/summarizer.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/lib/reader-data.ts`
- Modify: `src/worker/index.ts`
- Migration: `drizzle/0003_eminent_the_santerians.sql`
- Test: `tests/summarizer.test.ts`
- Test: `tests/ingest-items.test.ts`
- Test: `tests/reader-data.test.ts`

**Behavior:**
- Collection success means items were fetched and stored.
- Summary success/failure is a separate concern.
- Summary provider 429 should be visible in admin but not make source collection look broken.
- `collection_runs.status` remains the source-collection status.
- `collection_runs.summary_*` columns record summary attempts for that run:
  `summary_status`, attempted/succeeded/failed counts, and the last summary error code/message.
- Admin detail appends `已摘要 N 条`, `摘要限流`, `摘要需授权`, `摘要配置不完整`, `摘要超时`, or `摘要失败`.
  These are secondary details; they do not turn a successful collection into a failed monitor.

**Acceptance criteria:**
- StepFun/DeepSeek/OpenAI-compatible rate limit appears as "摘要限流".
- WeChat article collection remains "正常" when summaries fail.

## Task 6: Clarify delete semantics

**Files:**
- Modify: `src/components/monitor-list.tsx`
- Modify: `src/app/api/monitors/[id]/route.ts`
- Optional: add WeRSS unsubscribe helper in `src/connectors/wechat/werss-connector.ts`.

**Product decision:**
- Default MVP: deleting a SignalDeck monitor deletes only local monitoring and match links. It does not unsubscribe WeRSS automatically.
- UI copy must say: "只删除本地监控，不会删除 WeRSS 后台订阅".

**Acceptance criteria:**
- User is not surprised by lingering WeRSS subscriptions.
- Future optional checkbox can support "同时从 WeRSS 取消订阅".

## Task 7: Normalize source time and guard future items

**Files:**
- Modify: `src/connectors/trendradar/trendradar-connector.ts`
- Modify: `src/ingestion/ingest-items.ts`
- Test: `tests/trendradar-connector.test.ts`
- Test: `tests/ingest-items.test.ts`

**Behavior:**
- TrendRadar emits timezone-less China local timestamps. Parse them as Asia/Shanghai, not as container-local UTC.
- Keep explicit timezone timestamps (`Z`, `+08:00`, etc.) as absolute instants.
- Add a final ingestion guard: if any connector tries to store `publishedAt` more than 5 minutes in the future, clamp it to ingestion time.
- Backfill/correct already-stored TrendRadar rows that were shifted 8 hours into the future.

**Acceptance criteria:**
- On 2026-07-14 Asia/Shanghai, the "全部/最新" feed must not show `7月15日` from TrendRadar hotlist rows.
- DB query `published_at > now() + interval '5 minutes'` returns zero for all platforms.
- Existing future-shifted TrendRadar rows are corrected to the same Shanghai calendar day as their source timestamp.

## Task 8: Separate system-managed sidecars from user monitors

**Files:**
- Modify: `src/components/monitor-list.tsx`
- Modify: `src/components/admin-monitors-manager.tsx`
- Modify: `src/app/api/monitors/[id]/route.ts`
- Modify: `src/lib/reader-data.ts`
- Test: `tests/reader-data.test.ts`

**Behavior:**
- TrendRadar remains visible in the admin list because users need to know whether the built-in hotlist/RSS import is healthy.
- TrendRadar should be labeled `系统内置`.
- TrendRadar must not show edit/delete controls in the SignalDeck admin UI.
- The API must reject editing/deleting system-managed monitors, not merely hide controls in the frontend.

**Acceptance criteria:**
- Admin list shows `TrendRadar 实时热榜 · 系统内置 · 每 30 分钟 · 已采集 N 条`.
- Admin HTML does not render `编辑监控 TrendRadar` or `删除监控 TrendRadar`.
- `DELETE /api/monitors/:trendradarId` returns 400 with a Chinese explanation.

## Implementation Priority

1. Task 1: Stop misleading WeChat saves.
2. Task 2: Preserve WeChat metadata on edit.
3. Task 3: Admin status view model.
4. Task 4: Stale run cleanup.
5. Task 7: Source time normalization and future guard.
6. Task 8: System-managed sidecar boundary.
7. Task 5: Summary status split.
8. Task 6: Delete semantics copy.

The first three tasks are the minimum product-quality bar. Without them, the UI will continue to look "normal" while hiding broken source state.
