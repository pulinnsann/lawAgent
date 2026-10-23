-- Enterprise profiles reuse rule_sets and published rule_set_versions IDs.
CREATE TABLE enterprise_standard_drafts (
  standard_id TEXT PRIMARY KEY REFERENCES rule_sets(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name COLLATE NOCASE)
);
CREATE TABLE enterprise_standard_versions (
  version_id TEXT PRIMARY KEY REFERENCES rule_set_versions(id) ON DELETE RESTRICT,
  standard_id TEXT NOT NULL REFERENCES enterprise_standard_drafts(standard_id) ON DELETE RESTRICT,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64)
);
CREATE TRIGGER enterprise_draft_identity_immutable BEFORE UPDATE ON enterprise_standard_drafts
WHEN OLD.standard_id<>NEW.standard_id OR OLD.workspace_id<>NEW.workspace_id OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'enterprise draft identity/revision is immutable'); END;
CREATE TRIGGER enterprise_draft_workspace_valid BEFORE INSERT ON enterprise_standard_drafts
WHEN NOT EXISTS (SELECT 1 FROM rule_sets r WHERE r.id=NEW.standard_id AND r.workspace_id=NEW.workspace_id AND r.name=NEW.name)
BEGIN SELECT RAISE(ABORT, 'enterprise draft workspace does not match'); END;
CREATE TRIGGER enterprise_version_source_valid BEFORE INSERT ON enterprise_standard_versions
WHEN NOT EXISTS (SELECT 1 FROM rule_set_versions v WHERE v.id=NEW.version_id AND v.rule_set_id=NEW.standard_id AND v.content_sha256=NEW.content_sha256)
BEGIN SELECT RAISE(ABORT, 'enterprise version source does not match'); END;
CREATE TRIGGER enterprise_version_no_update BEFORE UPDATE ON enterprise_standard_versions
BEGIN SELECT RAISE(ABORT, 'enterprise version is immutable'); END;
CREATE TRIGGER enterprise_version_no_delete BEFORE DELETE ON enterprise_standard_versions
BEGIN SELECT RAISE(ABORT, 'enterprise version is immutable'); END;

CREATE TABLE risk_disposition_workspaces (
  review_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE risk_disposition_events (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES risk_disposition_workspaces(review_id) ON DELETE RESTRICT,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision>=1),
  status TEXT NOT NULL CHECK (status IN ('unreviewed','confirmed','needs_information','escalated','business_accepted','fixed','false_positive')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  actor_label TEXT NOT NULL CHECK (length(trim(actor_label)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE(review_id, revision)
);
CREATE TRIGGER risk_disposition_workspace_immutable BEFORE UPDATE ON risk_disposition_workspaces
WHEN OLD.review_id<>NEW.review_id OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'risk disposition workspace/revision is immutable'); END;
CREATE INDEX idx_risk_disposition_review ON risk_disposition_events(review_id, revision);
CREATE TRIGGER risk_disposition_event_source_valid BEFORE INSERT ON risk_disposition_events
WHEN NOT EXISTS (SELECT 1 FROM reports r JOIN findings f ON f.analysis_run_id=json_extract(r.input_manifest_json,'$.analysisRunIds[0]') WHERE r.id=NEW.review_id AND r.kind='risk' AND f.id=NEW.finding_id)
BEGIN SELECT RAISE(ABORT, 'risk disposition finding does not match review'); END;
CREATE TRIGGER risk_disposition_event_revision_valid BEFORE INSERT ON risk_disposition_events
WHEN NEW.revision<>(SELECT revision+1 FROM risk_disposition_workspaces WHERE review_id=NEW.review_id)
BEGIN SELECT RAISE(ABORT, 'risk disposition revision does not match'); END;
CREATE TRIGGER risk_disposition_event_no_update BEFORE UPDATE ON risk_disposition_events
BEGIN SELECT RAISE(ABORT, 'risk disposition event is immutable'); END;
CREATE TRIGGER risk_disposition_event_no_delete BEFORE DELETE ON risk_disposition_events
BEGIN SELECT RAISE(ABORT, 'risk disposition event is immutable'); END;
