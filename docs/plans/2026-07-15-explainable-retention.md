# Explainable Content Retention

## Goal

Every feed item should answer two different user questions without pretending that a model made the original collection decision:

1. Selection evidence: which subscription, search task, keyword rule or interest filter caused this item to enter SignalDeck.
2. Content value: what concrete information makes the item worth keeping, plus a 0-100 relevance/value score.

## Product rules

- Selection evidence comes from real monitor matches, never from the model.
- The model produces a short content-specific retention reason and score in the existing single analysis request.
- Rules provide a conservative fallback when the model omits those fields.
- Scores explain ordering/value; this release does not silently delete or hide content by score.
- The feed displays one concise reason, while the database keeps source, score and model route metadata.

## Done criteria

- New model responses include `keep_reason` and `relevance_score`.
- Existing and disabled-model items still receive a deterministic fallback.
- Reader cards show the reason and non-zero score.
- Monitor match evidence covers X, WeChat, web search, keyword rules and TrendRadar.
- Historical rows are migrated and can be improved by the existing backfill route.
