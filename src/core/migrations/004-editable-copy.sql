-- Explicit authorization is scoped to an immutable review/source version.
-- The original artifact and audit report remain untouched.
ALTER TABLE change_workspaces ADD COLUMN editable_copy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (editable_copy_enabled IN (0,1));
ALTER TABLE change_workspaces ADD COLUMN editable_copy_enabled_at TEXT;

CREATE TABLE change_editable_copy_events (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES change_workspaces(review_id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  source_file_sha256 TEXT NOT NULL CHECK (length(source_file_sha256) = 64),
  enabled_at TEXT NOT NULL
);

CREATE TRIGGER editable_copy_authorization_valid_insert BEFORE INSERT ON change_workspaces
WHEN (NEW.editable_copy_enabled = 0 AND NEW.editable_copy_enabled_at IS NOT NULL)
  OR (NEW.editable_copy_enabled = 1 AND NEW.editable_copy_enabled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'editable copy authorization is invalid'); END;

CREATE TRIGGER editable_copy_authorization_immutable BEFORE UPDATE ON change_workspaces
WHEN (NEW.editable_copy_enabled = 0 AND NEW.editable_copy_enabled_at IS NOT NULL)
  OR (NEW.editable_copy_enabled = 1 AND NEW.editable_copy_enabled_at IS NULL)
  OR (OLD.editable_copy_enabled = 1 AND (NEW.editable_copy_enabled <> 1 OR NEW.editable_copy_enabled_at IS NOT OLD.editable_copy_enabled_at))
BEGIN SELECT RAISE(ABORT, 'editable copy authorization is immutable'); END;

CREATE TRIGGER editable_copy_event_source_valid BEFORE INSERT ON change_editable_copy_events
WHEN NOT EXISTS (
  SELECT 1 FROM change_workspaces w WHERE w.review_id=NEW.review_id
    AND w.source_document_version_id=NEW.source_document_version_id
    AND w.source_file_sha256=NEW.source_file_sha256
    AND w.editable_copy_enabled=1 AND w.editable_copy_enabled_at=NEW.enabled_at
)
BEGIN SELECT RAISE(ABORT, 'editable copy event source does not match'); END;

CREATE TRIGGER editable_copy_event_no_update BEFORE UPDATE ON change_editable_copy_events
BEGIN SELECT RAISE(ABORT, 'editable copy event is immutable'); END;

CREATE TRIGGER editable_copy_event_no_delete BEFORE DELETE ON change_editable_copy_events
BEGIN SELECT RAISE(ABORT, 'editable copy event is immutable'); END;
