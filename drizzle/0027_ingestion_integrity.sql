-- 0027: Make document-analysis claims fenceable and discovery observations durable.

ALTER TABLE "document_analysis_claims"
  ADD COLUMN IF NOT EXISTS "claim_token" text;

UPDATE "document_analysis_claims"
SET "claim_token" = "id"::text
WHERE "claim_token" IS NULL;

ALTER TABLE "document_analysis_claims"
  ALTER COLUMN "claim_token" SET NOT NULL;

ALTER TABLE "monitor_match_observations"
  ADD COLUMN IF NOT EXISTS "observation_key" text;

-- Existing rows predate application-generated deterministic keys. Their UUID is
-- already immutable and unique, so it is a safe one-time backfill identity.
UPDATE "monitor_match_observations"
SET "observation_key" = "id"::text
WHERE "observation_key" IS NULL;

ALTER TABLE "monitor_match_observations"
  ALTER COLUMN "observation_key" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "match_observations_key_uidx"
  ON "monitor_match_observations" ("observation_key");

-- The former key was built from nullable foreign keys. ON DELETE SET NULL could
-- therefore turn distinct historical rows into duplicates and block deletion.
ALTER TABLE "monitor_match_observations"
  DROP CONSTRAINT IF EXISTS "monitor_match_observations_run_match_source_uidx";
DROP INDEX IF EXISTS "match_observations_run_match_source_uidx";

CREATE UNIQUE INDEX IF NOT EXISTS "source_items_id_item_uidx"
  ON "source_items" ("id", "item_id");

ALTER TABLE "item_matches"
  ADD CONSTRAINT "item_matches_source_document_fk"
  FOREIGN KEY ("source_item_id", "item_id")
  REFERENCES "source_items" ("id", "item_id")
  NOT VALID;

-- Enforce the source/document invariant for every new observation. NOT VALID
-- avoids making an upgrade impossible solely because of legacy audit rows; all
-- rows written after this migration are still checked by PostgreSQL.
ALTER TABLE "monitor_match_observations"
  ADD CONSTRAINT "match_observations_source_document_fk"
  FOREIGN KEY ("source_item_id", "match_item_id")
  REFERENCES "source_items" ("id", "item_id")
  NOT VALID;
