CREATE TABLE "event_developments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"development_key" text NOT NULL,
	"event_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"item_id" uuid,
	"source_revision" integer NOT NULL,
	"title" text NOT NULL,
	"evidence" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_reader_states" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"read_revision" integer DEFAULT 0 NOT NULL,
	"followed" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_revisions" (
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"title" text,
	"body_text" text NOT NULL,
	"change_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_revisions_item_id_revision_pk" PRIMARY KEY("item_id","revision")
);
--> statement-breakpoint
ALTER TABLE "content_events" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_events" ADD COLUMN "activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_events" ADD COLUMN "latest_change" text;--> statement-breakpoint
ALTER TABLE "event_items" ADD COLUMN "source_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "content_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_input_hash" text;--> statement-breakpoint
ALTER TABLE "event_developments" ADD CONSTRAINT "event_developments_event_id_content_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."content_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_developments" ADD CONSTRAINT "event_developments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reader_states" ADD CONSTRAINT "event_reader_states_event_id_content_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."content_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_developments_key_uidx" ON "event_developments" USING btree ("event_id","development_key");--> statement-breakpoint
CREATE INDEX "event_developments_revision_idx" ON "event_developments" USING btree ("event_id","event_revision");