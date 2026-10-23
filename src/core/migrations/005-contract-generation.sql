-- Completed generation results are independent immutable drafts, never reviews.
CREATE TABLE contract_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  language TEXT NOT NULL CHECK (language IN ('zh','en','th')),
  model_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contract_drafts_workspace ON contract_drafts(workspace_id, created_at DESC, id);
CREATE TABLE contract_draft_exports (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES contract_drafts(id) ON DELETE RESTRICT,
  document_version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE RESTRICT,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256)=64),
  created_at TEXT NOT NULL
);
CREATE TRIGGER contract_draft_no_update BEFORE UPDATE ON contract_drafts
BEGIN SELECT RAISE(ABORT, 'generated contract draft is immutable'); END;
CREATE TRIGGER contract_draft_no_delete BEFORE DELETE ON contract_drafts
BEGIN SELECT RAISE(ABORT, 'generated contract draft is immutable'); END;
CREATE TRIGGER contract_draft_export_valid BEFORE INSERT ON contract_draft_exports
WHEN NOT EXISTS (
  SELECT 1 FROM contract_drafts g
  JOIN document_versions d ON d.id=NEW.document_version_id
  JOIN contracts c ON c.id=d.contract_id
  WHERE g.id=NEW.draft_id AND g.workspace_id=c.workspace_id AND d.file_sha256=NEW.file_sha256
)
BEGIN SELECT RAISE(ABORT, 'generated contract export source is invalid'); END;
CREATE TRIGGER contract_draft_export_no_update BEFORE UPDATE ON contract_draft_exports
BEGIN SELECT RAISE(ABORT, 'generated contract export is immutable'); END;
CREATE TRIGGER contract_draft_export_no_delete BEFORE DELETE ON contract_draft_exports
BEGIN SELECT RAISE(ABORT, 'generated contract export is immutable'); END;
