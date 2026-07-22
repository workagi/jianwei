ALTER TABLE "collection_runs" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "collection_runs"
SET "scheduled_for" = "started_at",
    "idempotency_key" = 'legacy:collection-run:' || "id"::text
WHERE "scheduled_for" IS NULL OR "idempotency_key" IS NULL;--> statement-breakpoint
UPDATE "usage_ledger"
SET "idempotency_key" = 'legacy:usage:' || "id"::text
WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ALTER COLUMN "scheduled_for" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_runs_idempotency_uidx" ON "collection_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_idempotency_uidx" ON "usage_ledger" USING btree ("idempotency_key");
