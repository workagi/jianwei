CREATE TABLE "rate_limit_slots" (
	"key" text PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"monitor_id" uuid,
	"metric" text NOT NULL,
	"quantity" integer NOT NULL,
	"estimated_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_reservations_connector_status_idx" ON "usage_reservations" USING btree ("connector_id","status");--> statement-breakpoint
CREATE INDEX "usage_reservations_metric_status_idx" ON "usage_reservations" USING btree ("metric","status");--> statement-breakpoint
CREATE INDEX "usage_reservations_expiry_idx" ON "usage_reservations" USING btree ("expires_at");