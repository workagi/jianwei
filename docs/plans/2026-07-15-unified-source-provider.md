# Unified Source Provider Implementation Plan

**Goal:** Make every collector enter SignalDeck through one provider registry so adding a source no longer requires separate worker and preview-route branches.

**Compatibility:** Existing monitor platform values and configuration JSON remain unchanged. Existing X, WeRSS, WeChat keyword, Brave, Tavily, Serper and TrendRadar implementations are wrapped rather than rewritten.

## Steps

1. Define stable provider IDs, descriptors and a shared collect/validate contract.
2. Resolve provider IDs from the existing platform/config pair in one registry.
3. Route worker collection and admin preview through the registry.
4. Stamp normalized items with the provider that actually collected them.
5. Persist provider provenance in `items.source_provider` without changing deduplication.
6. Add unit/integration coverage, migrate Postgres, rebuild OrbStack containers and verify live data.

## Provider map

| Platform | Provider ID | Existing implementation |
| --- | --- | --- |
| X / Twitter | `x_official` | X API v2 connector |
| WeChat account | `wechat_werss` | WeRSS connector |
| WeChat keyword | `wechat_keyword` | Stored-item keyword rule |
| Web search | `web_brave` / `web_tavily` / `web_serper` | Existing search connectors |
| Hotlist / RSS | `trendradar` | TrendRadar MCP adapter |

## Done when

- Worker `gather()` has no platform-specific collection branch.
- Monitor validation has no provider-specific preview branch.
- Every newly ingested item records a stable source provider ID.
- Existing monitor payloads and UI URLs continue working unchanged.
