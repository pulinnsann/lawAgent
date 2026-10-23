-- Mutable proposal decisions are isolated from immutable review reports.
CREATE TABLE change_workspaces (
  review_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_file_sha256 TEXT NOT NULL CHECK (length(source_file_sha256) = 64),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE change_proposal_meta (
  proposal_id TEXT PRIMARY KEY REFERENCES change_proposals(id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL REFERENCES change_workspaces(review_id) ON DELETE RESTRICT,
  source_file_sha256 TEXT NOT NULL CHECK (length(source_file_sha256) = 64),
  explanation TEXT NOT NULL,
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  model_id TEXT
);

CREATE INDEX idx_change_meta_review ON change_proposal_meta(review_id, proposal_id);

CREATE TABLE change_proposal_events (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES change_workspaces(review_id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('created','edited','decision')),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE change_exports (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES change_workspaces(review_id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  resulting_document_version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_file_sha256 TEXT NOT NULL CHECK (length(source_file_sha256) = 64),
  result_file_sha256 TEXT NOT NULL CHECK (length(result_file_sha256) = 64),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_list TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_change_exports_review ON change_exports(review_id, created_at);

CREATE TRIGGER change_workspace_source_immutable BEFORE UPDATE ON change_workspaces
WHEN OLD.review_id <> NEW.review_id
  OR OLD.source_document_version_id <> NEW.source_document_version_id
  OR OLD.source_file_sha256 <> NEW.source_file_sha256
BEGIN SELECT RAISE(ABORT, 'change workspace source is immutable'); END;

CREATE TRIGGER change_meta_source_immutable BEFORE UPDATE ON change_proposal_meta
WHEN OLD.proposal_id <> NEW.proposal_id OR OLD.review_id <> NEW.review_id
  OR OLD.source_file_sha256 <> NEW.source_file_sha256
BEGIN SELECT RAISE(ABORT, 'change proposal metadata source is immutable'); END;

CREATE TRIGGER change_event_immutable BEFORE UPDATE ON change_proposal_events
BEGIN SELECT RAISE(ABORT, 'change proposal history is immutable'); END;

CREATE TRIGGER change_export_immutable BEFORE UPDATE ON change_exports
BEGIN SELECT RAISE(ABORT, 'change export snapshot is immutable'); END;
