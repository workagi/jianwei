CREATE TABLE "content_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_items" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_key" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost" numeric(12, 6),
	"reserved_cost" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"owner" uuid NOT NULL,
	"response" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "editorial_reason" text;--> statement-breakpoint
ALTER TABLE "event_items" ADD CONSTRAINT "event_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_items" ADD CONSTRAINT "event_items_event_id_content_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."content_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_attempts" ADD CONSTRAINT "model_attempts_receipt_key_model_receipts_key_fk" FOREIGN KEY ("receipt_key") REFERENCES "public"."model_receipts"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_items_event_idx" ON "event_items" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "model_attempts_started_idx" ON "model_attempts" USING btree ("started_at");
--> statement-breakpoint
UPDATE items SET editorial_reason = retention_reason
WHERE retention_source = 'model' AND nullif(btrim(retention_reason), '') IS NOT NULL;
