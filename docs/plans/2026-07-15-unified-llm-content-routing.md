# Unified LLM Content Routing

## Goal

Every newly collected or historical item must pass through the same content-understanding boundary. The route produces one user-facing summary, one content type and topic tags, while persisting a per-item processing status that can be observed and retried.

## Product rules

- Source providers only collect and normalize content; they do not decide model behavior.
- One model request produces summary, content type and topic tags together.
- Model output wins. Local rules fill missing classification fields only and are recorded as a fallback.
- A failed or skipped model call must never block ingestion.
- Existing model output must not be overwritten by a later polling pass.
- Backfill uses the same route as new-item ingestion.

## Per-item state

- `pending`: not routed yet.
- `success`: model returned a complete, quality-checked structure.
- `partial`: model summary is usable but classification needed a local fallback.
- `failed`: a model request failed or produced unusable output.
- `skipped`: the platform or missing full text made the item ineligible.
- `disabled`: no model provider was enabled.

Each item also records provider, model, route version, attempts, last error and processed time.

## Done criteria

- New ingestion and historical backfill call the same router.
- Model-generated fields survive repeated collection.
- Failed items are queryable and retryable.
- The content pipeline dashboard reports real model-routing completion and failures.
- Existing data is migrated without losing summaries or tags.
