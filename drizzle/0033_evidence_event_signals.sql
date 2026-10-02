ALTER TABLE "event_items" ADD COLUMN "signal_fingerprint" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "event_signal" jsonb;