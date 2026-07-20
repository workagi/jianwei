import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const platformType = pgEnum("platform_type", ["x", "wechat", "web_search", "trendradar"]);
export const healthStatus = pgEnum("health_status", [
  "pending",
  "healthy",
  "auth_required",
  "rate_limited",
  "budget_exhausted",
  "failed",
]);
export const runStatus = pgEnum("run_status", ["running", "success", "partial", "failed"]);

export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: platformType("platform").notNull(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  healthStatus: healthStatus("health_status").notNull().default("pending"),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorCredentials = pgTable("connector_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  encryptedPayload: text("encrypted_payload").notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const monitors = pgTable("monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: platformType("platform").notNull(),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  name: text("name").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(30),
  cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
  failureCount: integer("failure_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("monitors_due_idx").on(table.enabled, table.nextRunAt),
  index("monitors_platform_idx").on(table.platform),
]);

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: platformType("platform").notNull(),
  sourceProvider: text("source_provider"),
  upstreamId: text("upstream_id").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  authorId: text("author_id"),
  authorName: text("author_name"),
  authorHandle: text("author_handle"),
  avatarUrl: text("avatar_url"),
  title: text("title"),
  // 模型生成的中文显示文本：文章为中文标题，X 为忠实中文推文；原始内容始终保留。
  translatedTitle: text("translated_title"),
  bodyText: text("body_text").notNull(),
  // AI 读完全文后生成的内容摘要（离线回填），前端优先展示，缺失时回退 bodyText。
  aiSummary: text("ai_summary"),
  // 内容类型用于顶部筛选（单选、相对稳定）；主题标签用于卡片展示（多选、可扩展）。
  contentType: text("content_type"),
  topicTags: jsonb("topic_tags").$type<string[]>().notNull().default([]),
  retentionReason: text("retention_reason"),
  relevanceScore: integer("relevance_score"),
  retentionSource: text("retention_source"),
  // Durable per-item state for the unified LLM content route. Rule-derived
  // classification may exist while this status is still pending/failed.
  analysisStatus: text("analysis_status").notNull().default("pending"),
  analysisProvider: text("analysis_provider"),
  analysisModel: text("analysis_model"),
  analysisVersion: text("analysis_version"),
  analysisAttempts: integer("analysis_attempts").notNull().default(0),
  analysisErrorCode: text("analysis_error_code"),
  analysisErrorMessage: text("analysis_error_message"),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  contentHtml: text("content_html"),
  contentProvider: text("content_provider"),
  contentFetchStatus: text("content_fetch_status"),
  contentFetchError: text("content_fetch_error"),
  contentFetchedAt: timestamp("content_fetched_at", { withTimezone: true }),
  imageUrls: jsonb("image_urls").$type<string[]>().notNull().default([]),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("items_platform_upstream_uidx").on(table.platform, table.upstreamId),
  uniqueIndex("items_canonical_url_uidx").on(table.canonicalUrl),
  index("items_published_idx").on(table.publishedAt),
  index("items_source_provider_idx").on(table.sourceProvider),
  index("items_content_type_idx").on(table.contentType),
  index("items_relevance_score_idx").on(table.relevanceScore),
  index("items_analysis_status_idx").on(table.analysisStatus),
  index("items_content_hash_idx").on(table.contentHash),
]);

export const itemMatches = pgTable("item_matches", {
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  matchedQuery: text("matched_query"),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.itemId, table.monitorId] })]);

// SignalDeck is currently a single-user workspace. A dedicated join table
// keeps bookmark state durable across browsers and leaves room for a user_id
// column if multi-user accounts are introduced later.
export const bookmarks = pgTable("bookmarks", {
  itemId: uuid("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const collectionRuns = pgTable("collection_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  status: runStatus("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  fetchedCount: integer("fetched_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  matchedCount: integer("matched_count").notNull().default(0),
  providerCost: numeric("provider_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  summaryStatus: text("summary_status").notNull().default("not_applicable"),
  summaryAttemptedCount: integer("summary_attempted_count").notNull().default(0),
  summarySucceededCount: integer("summary_succeeded_count").notNull().default(0),
  summaryFailedCount: integer("summary_failed_count").notNull().default(0),
  summaryErrorCode: text("summary_error_code"),
  summaryErrorMessage: text("summary_error_message"),
});

export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "set null" }),
  metric: text("metric").notNull(),
  quantity: integer("quantity").notNull(),
  estimatedCost: numeric("estimated_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runtimeHealth = pgTable("runtime_health", {
  service: text("service").primaryKey(),
  status: text("status").notNull().default("ok"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
});

/**
 * 平台 API 凭据（X / Brave / WeRSS）。存库而非只放 .env 的原因：允许在
 * 后台界面直接配置、保存后立即生效（worker 每轮采集前刷新到 process.env），
 * 无需重启、无需手动改文件。
 * value 使用 APP_ENCRYPTION_KEY 通过 AES-256-GCM 加密；服务端读取时解密，
 * 浏览器端只会拿到“是否已配置”，不会拿到密钥内容。
 */
export const apiCredentials = pgTable("api_credentials", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
