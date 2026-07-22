CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"platform" "platform_type" NOT NULL,
	"source_provider" text NOT NULL,
	"upstream_id" text NOT NULL,
	"source_url" text NOT NULL,
	"author_id" text,
	"author_name" text,
	"author_handle" text,
	"avatar_url" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "relevance_score" integer;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "retention_reason" text;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "retention_source" text;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "analysis_status" text;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "analysis_version" text;--> statement-breakpoint
ALTER TABLE "item_matches" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "information_value_score" integer;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_items_identity_uidx" ON "source_items" USING btree ("platform","source_provider","upstream_id");--> statement-breakpoint
CREATE INDEX "source_items_item_seen_idx" ON "source_items" USING btree ("item_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "source_items_platform_seen_idx" ON "source_items" USING btree ("platform","last_seen_at");--> statement-breakpoint
ALTER TABLE "item_matches" ADD CONSTRAINT "item_matches_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_matches_source_item_idx" ON "item_matches" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "item_matches_monitor_relevance_idx" ON "item_matches" USING btree ("monitor_id","relevance_score");--> statement-breakpoint
CREATE INDEX "items_information_value_score_idx" ON "items" USING btree ("information_value_score");--> statement-breakpoint
UPDATE "items"
SET "information_value_score" = "relevance_score"
WHERE "information_value_score" IS NULL;--> statement-breakpoint
INSERT INTO "source_items" (
	"item_id",
	"platform",
	"source_provider",
	"upstream_id",
	"source_url",
	"author_id",
	"author_name",
	"author_handle",
	"avatar_url",
	"raw_payload",
	"published_at",
	"first_seen_at",
	"last_seen_at"
)
SELECT
	i."id",
	i."platform",
	coalesce(nullif(btrim(i."source_provider"), ''), i."platform"::text),
	i."upstream_id",
	i."canonical_url",
	i."author_id",
	i."author_name",
	i."author_handle",
	i."avatar_url",
	coalesce((
		select im."raw_payload"
		from "item_matches" im
		where im."item_id" = i."id"
		order by im."first_seen_at" asc
		limit 1
	), '{}'::jsonb),
	i."published_at",
	i."created_at",
	i."updated_at"
FROM "items" i
ON CONFLICT ("platform", "source_provider", "upstream_id") DO NOTHING;--> statement-breakpoint
UPDATE "item_matches" im
SET
	"source_item_id" = si."id",
	"relevance_score" = i."information_value_score",
	"retention_reason" = i."retention_reason",
	"retention_source" = i."retention_source",
	"analysis_status" = i."analysis_status",
	"analysis_version" = i."analysis_version",
	"last_seen_at" = im."first_seen_at"
FROM "items" i
JOIN "source_items" si ON si."item_id" = i."id"
WHERE im."item_id" = i."id";
