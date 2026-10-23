-- Add partial retrieval attempts and a separate contract-template evidence kind.
-- AppStore runs this file in a transaction with foreign_keys disabled,
-- checks all foreign keys before commit, and retains a v1 file backup.


CREATE TABLE retrieval_attempts_v2 (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE RESTRICT,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('knowledge','web')),
  query TEXT NOT NULL,
  query_language TEXT NOT NULL CHECK (query_language IN ('zh','en','th')),
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),
  status TEXT NOT NULL CHECK (status IN ('queued','running','complete','empty','partial','timeout','failed','cancelled')),
  result_count INTEGER CHECK (result_count IS NULL OR result_count >= 0),
  error_code TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (status <> 'empty' OR (result_count IS NOT NULL AND result_count = 0)),
  CHECK (status <> 'complete' OR (result_count IS NOT NULL AND result_count > 0))
);

INSERT INTO retrieval_attempts_v2 SELECT * FROM retrieval_attempts;

DROP TABLE retrieval_attempts;

ALTER TABLE retrieval_attempts_v2 RENAME TO retrieval_attempts;

CREATE TABLE evidence_v2 (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  retrieval_attempt_id TEXT REFERENCES retrieval_attempts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('statute','judicial_interpretation','case','company_policy','approved_clause','commentary','contract_template','transaction_fact')),
  origin TEXT NOT NULL CHECK (origin IN ('knowledge','web','contract','user')),
  external_source_id TEXT,
  title TEXT NOT NULL,
  source_url TEXT,
  source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json)),
  original_excerpt TEXT NOT NULL,
  excerpt_sha256 TEXT NOT NULL CHECK (length(excerpt_sha256) = 64),
  language TEXT NOT NULL CHECK (language IN ('zh','en','th','mixed','unknown')),
  source_version TEXT,
  jurisdiction TEXT,
  issued_on TEXT,
  effective_from TEXT,
  effective_to TEXT,
  retrieved_at TEXT NOT NULL,
  currentness TEXT NOT NULL CHECK (currentness IN ('current','historical','superseded','not_applicable','unknown')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','verified','partially_verified','failed')),
  verification_notes TEXT,
  conflict_group_id TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);

INSERT INTO evidence_v2 SELECT * FROM evidence;

DROP TABLE evidence;

ALTER TABLE evidence_v2 RENAME TO evidence;

CREATE INDEX idx_retrieval_run ON retrieval_attempts(analysis_run_id, channel, status);

CREATE INDEX idx_evidence_run ON evidence(analysis_run_id, kind, verification_status);

CREATE INDEX idx_evidence_external ON evidence(origin, external_source_id, source_version);

CREATE TRIGGER evidence_source_immutable BEFORE UPDATE ON evidence
WHEN OLD.analysis_run_id <> NEW.analysis_run_id OR OLD.retrieval_attempt_id IS NOT NEW.retrieval_attempt_id
  OR OLD.origin <> NEW.origin OR OLD.external_source_id IS NOT NEW.external_source_id
  OR OLD.source_url IS NOT NEW.source_url OR OLD.source_locator_json <> NEW.source_locator_json
  OR OLD.original_excerpt <> NEW.original_excerpt OR OLD.excerpt_sha256 <> NEW.excerpt_sha256
  OR OLD.language <> NEW.language OR OLD.source_version IS NOT NEW.source_version
BEGIN SELECT RAISE(ABORT, 'evidence source snapshot is immutable; create a new evidence record'); END;
