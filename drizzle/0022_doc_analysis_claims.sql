CREATE TABLE IF NOT EXISTS document_analysis_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url_hash text NOT NULL,
  analysis_version text NOT NULL,
  owner_worker_id text NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX doc_analysis_claim_uidx
  ON document_analysis_claims (canonical_url_hash, analysis_version);

CREATE INDEX doc_analysis_claim_expires_idx
  ON document_analysis_claims (expires_at);
