ALTER TABLE "items" ADD COLUMN "source_provider" text;--> statement-breakpoint
CREATE INDEX "items_source_provider_idx" ON "items" USING btree ("source_provider");--> statement-breakpoint
UPDATE "items"
SET "source_provider" = CASE
  WHEN "platform" = 'x' THEN 'x_official'
  WHEN "platform" = 'wechat' THEN 'wechat_werss'
  WHEN "platform" = 'trendradar' THEN 'trendradar'
  WHEN "platform" = 'web_search' THEN coalesce((
    SELECT CASE coalesce(m."config"->>'provider', 'brave')
      WHEN 'tavily' THEN 'web_tavily'
      WHEN 'serper' THEN 'web_serper'
      ELSE 'web_brave'
    END
    FROM "item_matches" im
    JOIN "monitors" m ON m."id" = im."monitor_id"
    WHERE im."item_id" = "items"."id" AND m."platform" = 'web_search'
    ORDER BY im."first_seen_at" ASC
    LIMIT 1
  ), 'web_brave')
  ELSE NULL
END
WHERE "source_provider" IS NULL;
