ALTER TABLE "items" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "topic_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "items_content_type_idx" ON "items" USING btree ("content_type");