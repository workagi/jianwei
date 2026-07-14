# TrendRadar Integration Decision

## Decision

Use TrendRadar as a separate Docker/MCP sidecar for the capabilities it already owns. Keep SignalDeck as the dynamic source-management and AI HOT-style reading product.

Do not copy TrendRadar source code into SignalDeck. TrendRadar is GPL-3.0; process-level integration through Docker volumes, HTTP/MCP, and documented output keeps the boundary explicit and makes upstream upgrades easier.

## Capability ownership

| Capability | Owner | Reason |
| --- | --- | --- |
| NewsNow platform hotlists | TrendRadar | Already supports configurable platform IDs and domain validation. |
| RSS/Atom polling | TrendRadar | Already supports freshness filtering, GUID/URL deduplication, display grouping, and history. |
| Keyword grammar and AI interest filtering | TrendRadar | Already supports include, required, excluded, regex, aliases, limits, and AI fallback. |
| Scheduling, daily/current/incremental modes | TrendRadar | Mature timeline and push-window implementation. |
| AI analysis, translation, reports, notifications | TrendRadar | Mature multi-provider and multi-channel implementation. |
| Arbitrary public X account | SignalDeck X connector | TrendRadar platforms are hotlist sources, not arbitrary account timelines. |
| Arbitrary WeChat Official Account | WeRSS sidecar | TrendRadar can consume the resulting RSS feed but does not discover arbitrary accounts itself. |
| Whole-web keyword search | SignalDeck search connector | TrendRadar filters collected sources; it is not a general web search index. |
| Dynamic admin CRUD | SignalDeck | TrendRadar is primarily config-file driven and documents restart-after-config-change. |
| Unified reader and favorites | SignalDeck | The requested product is a persistent AI HOT-style dashboard, not only generated reports. |

## Integration shape

```text
NewsNow platforms ─┐
Existing RSS feeds ├─> TrendRadar ── MCP HTTP ──> SignalDeck ingestion ──> PostgreSQL ──> Reader
AI/filter/report  ─┘

X official API ───────────────┐
WeRSS account feeds ──────────┼─> SignalDeck connector pipeline ────────────────┘
Brave whole-web search ───────┘
```

TrendRadar remains the source of truth for its own hotlist/RSS history. SignalDeck stores normalized copies and match records needed by its reader; it must preserve upstream IDs so synchronization stays idempotent.

## First integration spike

1. Start `wantcat/trendradar` and `wantcat/trendradar-mcp` with shared `config` and `output` volumes.
2. Call MCP tools `get_system_status`, `get_latest_news`, `get_latest_rss`, and `search_news` over `http://trendradar-mcp:3333/mcp`.
3. Record the exact structured response shapes and stable upstream identifiers.
4. Implement only one `TrendRadarConnector` normalization layer in SignalDeck.
5. Do not reimplement TrendRadar keyword grammar, report generation, AI filtering, or notification delivery.

## Deployment boundary

The final Docker Compose installation should contain:

- `signaldeck-web`
- `signaldeck-worker`
- `postgres`
- `trendradar`
- `trendradar-mcp`
- `werss`

TrendRadar config/output and WeRSS data use independent named volumes. The SignalDeck container must not mount the Docker socket.
