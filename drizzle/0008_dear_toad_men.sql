ALTER TABLE "items" ADD COLUMN "retention_reason" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "relevance_score" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "retention_source" text;--> statement-breakpoint
CREATE INDEX "items_relevance_score_idx" ON "items" USING btree ("relevance_score");--> statement-breakpoint
UPDATE "items"
SET
  "retention_reason" = CASE
    WHEN "content_type" = 'product_update' THEN '包含可核对的产品动态信息'
    WHEN "content_type" = 'model_release' THEN '包含可核对的模型发布信息'
    WHEN "content_type" = 'industry_business' THEN '包含可核对的行业商业信息'
    WHEN "content_type" = 'research' THEN '包含可核对的论文研究信息'
    WHEN "content_type" = 'tutorial' THEN '包含可复用的实践教程信息'
    WHEN "content_type" = 'policy_safety' THEN '包含可核对的政策安全信息'
    WHEN "content_type" = 'opinion' THEN '包含有明确主题的观点解读'
    ELSE '来自已配置监控任务的可核对信息'
  END,
  "relevance_score" = least(88,
    45
    + CASE WHEN nullif(btrim("ai_summary"), '') IS NOT NULL AND length(btrim("ai_summary")) >= 24 THEN 12 ELSE 0 END
    + least(16, jsonb_array_length("topic_tags") * 4)
    + CASE WHEN "content_type" IS NOT NULL AND "content_type" <> 'opinion' THEN 5 ELSE 0 END
    + CASE WHEN length(coalesce("content_html", "body_text")) >= 180 THEN 6 ELSE 0 END
    + CASE WHEN nullif(btrim("title"), '') IS NOT NULL THEN 3 ELSE 0 END
  ),
  "retention_source" = 'rules'
WHERE "retention_reason" IS NULL OR "relevance_score" IS NULL;
