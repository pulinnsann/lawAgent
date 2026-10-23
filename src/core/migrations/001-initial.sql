-- 首个开发版本的空库初始化迁移，源自 docs/contracts/schema-v1.sql，2026-10-22。
-- 映射约定见 domain-v1.ts：UUID/Timestamp/Date/DecimalString 均为 TEXT，JSON 使用 TEXT。
-- 应用启动时对每个连接启用 foreign_keys；迁移执行前备份并校验 schema_version。
-- 本迁移只在空库执行；后续升级增加有序迁移文件，不可反复覆盖旧库。
-- 文件内容放应用管理目录；表中 artifact_uri 保存相对标识。不得存 API Key/密码。
-- 必须在服务层执行 JSON DTO、UUID/RFC3339/日期/十进制及工作区关系校验；CHECK 不是完整校验器。
PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  our_party_role TEXT,
  governing_law_status TEXT NOT NULL CHECK (governing_law_status IN ('prc','foreign','unknown')),
  governing_law_text TEXT,
  transaction_context_json TEXT NOT NULL CHECK (json_valid(transaction_context_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('model','knowledge','web')),
  name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model_id TEXT,
  credential_ref TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind, name)
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('original','revised','reparsed','generated')),
  source_format TEXT NOT NULL CHECK (source_format IN ('docx','pdf')),
  artifact_uri TEXT NOT NULL,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  language TEXT NOT NULL CHECK (language IN ('zh','en','th','mixed','unknown')),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('pending','parsing','ready','partial','failed')),
  parse_issues_json TEXT NOT NULL CHECK (json_valid(parse_issues_json)),
  parser_snapshot_json TEXT NOT NULL CHECK (json_valid(parser_snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, version_no),
  CHECK (parent_version_id IS NULL OR parent_version_id <> id)
);

CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  block_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('paragraph','list_item','table_cell','header','footer','other')),
  language TEXT NOT NULL CHECK (language IN ('zh','en','th','mixed','unknown')),
  original_text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  created_at TEXT NOT NULL,
  UNIQUE (document_version_id, block_key),
  UNIQUE (document_version_id, ordinal)
);

CREATE TABLE block_translations (
  id TEXT PRIMARY KEY,
  document_block_id TEXT NOT NULL REFERENCES document_blocks(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('zh','en','th')),
  translated_text TEXT NOT NULL,
  source_text_sha256 TEXT NOT NULL CHECK (length(source_text_sha256) = 64),
  model_snapshot_json TEXT NOT NULL CHECK (json_valid(model_snapshot_json)),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unreviewed','reviewed','disputed')),
  created_at TEXT NOT NULL
);

CREATE TABLE rule_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE rule_set_versions (
  id TEXT PRIMARY KEY,
  rule_set_id TEXT NOT NULL REFERENCES rule_sets(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction = 'PRC'),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  workflow_config_json TEXT NOT NULL CHECK (json_valid(workflow_config_json)),
  business_thresholds_json TEXT NOT NULL CHECK (json_valid(business_thresholds_json)),
  presentation_preferences_json TEXT NOT NULL CHECK (json_valid(presentation_preferences_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  approved_by_label TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (rule_set_id, version_no)
);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  title TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('zh','en','th')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction = 'PRC'),
  artifact_uri TEXT NOT NULL,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  field_schema_json TEXT NOT NULL CHECK (json_valid(field_schema_json)),
  applicability_json TEXT NOT NULL CHECK (json_valid(applicability_json)),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('draft','approved','retired')),
  approved_by_label TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, template_key, version_no),
  CHECK (approval_status <> 'approved' OR (approved_by_label IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('review','drafting')),
  document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  template_version_id TEXT REFERENCES template_versions(id) ON DELETE RESTRICT,
  output_document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  rule_set_version_id TEXT NOT NULL REFERENCES rule_set_versions(id) ON DELETE RESTRICT,
  model_provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_input','awaiting_review','completed','partial','failed','cancelled')),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction = 'PRC'),
  our_party_role TEXT NOT NULL,
  report_language TEXT NOT NULL CHECK (report_language IN ('zh','en','th')),
  input_snapshot_json TEXT NOT NULL CHECK (json_valid(input_snapshot_json)),
  model_snapshot_json TEXT NOT NULL CHECK (json_valid(model_snapshot_json)),
  prompt_snapshot_json TEXT NOT NULL CHECK (json_valid(prompt_snapshot_json)),
  retrieval_policy_snapshot_json TEXT NOT NULL CHECK (json_valid(retrieval_policy_snapshot_json)),
  applied_memory_revision_ids_json TEXT NOT NULL CHECK (json_valid(applied_memory_revision_ids_json)),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  supersedes_run_id TEXT REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  CHECK (kind <> 'review' OR document_version_id IS NOT NULL),
  CHECK (kind <> 'drafting' OR template_version_id IS NOT NULL),
  CHECK (supersedes_run_id IS NULL OR supersedes_run_id <> id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('parse','review','draft','retrieve','verify','export','summarize','memory_extract')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','partial','failed','cancelled')),
  stage TEXT NOT NULL,
  progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  idempotency_key TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_json TEXT CHECK (estimated_cost_json IS NULL OR json_valid(estimated_cost_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key),
  CHECK (attempt_no <= max_attempts)
);

-- 本表在工作区库中保存其作用域收据；全局注册库使用同形专用迁移，null 只用于 bootstrap。
-- registry 子集没有 tasks 表，须移除 task_id 外键并约束其为 null，不能原样复制本表 DDL。
-- 现有工作区命令不得传 null。范围归属由 Core 校验，不把 workspace_id 当权限证明。
-- 非任务写操作与 completed 收据在同一 SQLite 事务提交；长任务和其 completed 收据
-- 在同一事务创建，task_id/result 返回原 TaskHandle，任务进度仍以 tasks 为准。
-- 重复 key 同 payload 返回原收据；不同 payload 返回 IDEMPOTENCY_CONFLICT。
-- in_progress 重复请求不能再次执行，须等待/恢复/返回可重试处理中状态。
-- 文件、系统凭据库和网络副作用不在 SQLite 原子事务内，使用暂存与恢复步骤协调。
-- 不持久化原始 payload、认证头、临时文件令牌或明文密钥。秘密字段通过系统凭据保护
-- 的 HMAC 先形成不可逆私密指纹，再参与规范化 payload_sha256；result 仅缓存脱敏 DTO。
CREATE TABLE command_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  command_name TEXT NOT NULL CHECK (length(trim(command_name)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'),
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, command_name, idempotency_key),
  CHECK (status <> 'in_progress' OR (result_json IS NULL AND error_code IS NULL)),
  CHECK (status <> 'completed' OR (error_code IS NULL AND (result_json IS NOT NULL OR task_id IS NOT NULL))),
  CHECK (status <> 'failed' OR (error_code IS NOT NULL AND result_json IS NULL AND task_id IS NULL))
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('research','missing_fact')),
  text TEXT NOT NULL,
  document_block_ids_json TEXT NOT NULL CHECK (json_valid(document_block_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('open','answered','unresolved','out_of_scope')),
  answer TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE retrieval_attempts (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE RESTRICT,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('knowledge','web')),
  query TEXT NOT NULL,
  query_language TEXT NOT NULL CHECK (query_language IN ('zh','en','th')),
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),
  status TEXT NOT NULL CHECK (status IN ('queued','running','complete','empty','timeout','failed','cancelled')),
  result_count INTEGER CHECK (result_count IS NULL OR result_count >= 0),
  error_code TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (status <> 'empty' OR (result_count IS NOT NULL AND result_count = 0)),
  CHECK (status <> 'complete' OR (result_count IS NOT NULL AND result_count > 0))
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  retrieval_attempt_id TEXT REFERENCES retrieval_attempts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('statute','judicial_interpretation','case','company_policy','approved_clause','commentary','transaction_fact')),
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

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  rule_key TEXT,
  category TEXT NOT NULL CHECK (category IN ('legal','commercial','operational')),
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low','unrated')),
  legal_review_status TEXT NOT NULL CHECK (legal_review_status IN ('unreviewed','confirmed','disputed','needs_information')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  triggering_facts_json TEXT NOT NULL CHECK (json_valid(triggering_facts_json)),
  assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
  recommendation TEXT NOT NULL,
  unresolved_questions_json TEXT NOT NULL CHECK (json_valid(unresolved_questions_json)),
  document_block_ids_json TEXT NOT NULL CHECK (json_valid(document_block_ids_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE finding_evidence (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','context')),
  explanation TEXT NOT NULL,
  PRIMARY KEY (finding_id, evidence_id, relation)
);

CREATE TABLE dispositions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('propose_fix','request_information','escalate','accept_business_risk','mark_fixed','reopen')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','advisor','system')),
  actor_label TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  related_document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  finding_id TEXT REFERENCES findings(id) ON DELETE RESTRICT,
  source_document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  document_block_id TEXT NOT NULL REFERENCES document_blocks(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('replace','insert_before','insert_after')),
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end >= range_start),
  expected_original_text TEXT NOT NULL,
  expected_original_text_sha256 TEXT NOT NULL CHECK (length(expected_original_text_sha256) = 64),
  replacement_text TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('zh','en','th')),
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','applied','stale','failed')),
  resulting_document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'applied' OR resulting_document_version_id IS NOT NULL),
  CHECK (operation = 'replace' OR range_start = range_end)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  kind TEXT NOT NULL CHECK (kind IN ('risk','legal_analysis','leadership_summary','work_summary','change_list')),
  language TEXT NOT NULL CHECK (language IN ('zh','en','th')),
  status TEXT NOT NULL CHECK (status IN ('draft','reviewed','exported')),
  input_manifest_json TEXT NOT NULL CHECK (json_valid(input_manifest_json)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  artifact_uri TEXT,
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, report_key, version_no),
  CHECK ((artifact_uri IS NULL) = (file_sha256 IS NULL)),
  CHECK (status <> 'exported' OR artifact_uri IS NOT NULL)
);

CREATE TABLE report_sources (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  evidence_id TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  document_version_id TEXT REFERENCES document_versions(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL,
  CHECK ((analysis_run_id IS NOT NULL) + (evidence_id IS NOT NULL) + (document_version_id IS NOT NULL) = 1)
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  finding_id TEXT REFERENCES findings(id) ON DELETE RESTRICT,
  change_proposal_id TEXT REFERENCES change_proposals(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('false_positive','missed_issue','business_accepted','wording_changed','correct','other')),
  before_text TEXT,
  after_text TEXT,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','advisor','system')),
  actor_label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('preference','rule','clause')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace','project','contract')),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  contract_id TEXT REFERENCES contracts(id) ON DELETE RESTRICT,
  party_role TEXT,
  language TEXT CHECK (language IS NULL OR language IN ('zh','en','th')),
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate','active','disabled','revoked')),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id, current_revision_id) REFERENCES memory_revisions(memory_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope_kind = 'workspace' AND project_id IS NULL AND contract_id IS NULL) OR
         (scope_kind = 'project' AND project_id IS NOT NULL AND contract_id IS NULL) OR
         (scope_kind = 'contract' AND contract_id IS NOT NULL AND project_id IS NULL)),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  CHECK (status <> 'active' OR current_revision_id IS NOT NULL)
);

CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  source_feedback_id TEXT REFERENCES feedback(id) ON DELETE RESTRICT,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('candidate','approved','rejected')),
  approved_by_label TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, version_no),
  UNIQUE (memory_id, id),
  CHECK (approval_status <> 'approved' OR (approved_by_label IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','advisor','system')),
  actor_label TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_contracts_workspace ON contracts(workspace_id, updated_at);
CREATE INDEX idx_document_versions_contract ON document_versions(contract_id, created_at);
CREATE INDEX idx_document_blocks_order ON document_blocks(document_version_id, ordinal);
CREATE INDEX idx_analysis_runs_contract ON analysis_runs(contract_id, created_at);
CREATE INDEX idx_tasks_resume ON tasks(status, updated_at);
CREATE UNIQUE INDEX idx_command_receipt_scope ON command_receipts(COALESCE(workspace_id, '__bootstrap__'), command_name, idempotency_key);
CREATE INDEX idx_command_receipt_resume ON command_receipts(status, updated_at);
CREATE INDEX idx_questions_run ON questions(analysis_run_id, status);
CREATE INDEX idx_retrieval_run ON retrieval_attempts(analysis_run_id, channel, status);
CREATE INDEX idx_evidence_run ON evidence(analysis_run_id, kind, verification_status);
CREATE INDEX idx_evidence_external ON evidence(origin, external_source_id, source_version);
CREATE INDEX idx_findings_run ON findings(analysis_run_id, category, severity);
CREATE INDEX idx_dispositions_history ON dispositions(finding_id, created_at, id);
CREATE INDEX idx_changes_source ON change_proposals(source_document_version_id, status);
CREATE INDEX idx_reports_workspace ON reports(workspace_id, kind, created_at);
CREATE UNIQUE INDEX idx_report_source_run ON report_sources(report_id, analysis_run_id) WHERE analysis_run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_report_source_evidence ON report_sources(report_id, evidence_id) WHERE evidence_id IS NOT NULL;
CREATE UNIQUE INDEX idx_report_source_document ON report_sources(report_id, document_version_id) WHERE document_version_id IS NOT NULL;
CREATE INDEX idx_feedback_workspace ON feedback(workspace_id, created_at);
CREATE INDEX idx_memories_applicability ON memories(workspace_id, status, kind, scope_kind, party_role, language);
CREATE INDEX idx_audit_history ON audit_events(workspace_id, entity_type, entity_id, created_at);

-- 不可变证据定位及标准版本；重新解析/修订应创建新版本。
CREATE TRIGGER command_receipt_identity_immutable BEFORE UPDATE ON command_receipts
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.command_name <> NEW.command_name
  OR OLD.idempotency_key <> NEW.idempotency_key OR OLD.payload_sha256 <> NEW.payload_sha256
BEGIN SELECT RAISE(ABORT, 'command idempotency identity is immutable'); END;

CREATE TRIGGER command_receipt_terminal_immutable BEFORE UPDATE ON command_receipts
WHEN OLD.status IN ('completed','failed')
BEGIN SELECT RAISE(ABORT, 'terminal command receipt is immutable; replay the original result'); END;

CREATE TRIGGER document_blocks_no_update BEFORE UPDATE ON document_blocks
BEGIN SELECT RAISE(ABORT, 'document block is immutable; create a new document version'); END;

CREATE TRIGGER document_source_immutable BEFORE UPDATE ON document_versions
WHEN OLD.contract_id <> NEW.contract_id OR OLD.version_no <> NEW.version_no
  OR OLD.parent_version_id IS NOT NEW.parent_version_id OR OLD.kind <> NEW.kind
  OR OLD.source_format <> NEW.source_format OR OLD.artifact_uri <> NEW.artifact_uri
  OR OLD.file_sha256 <> NEW.file_sha256 OR OLD.byte_size <> NEW.byte_size
BEGIN SELECT RAISE(ABORT, 'document source is immutable; create a new document version'); END;

CREATE TRIGGER rule_set_versions_no_update BEFORE UPDATE ON rule_set_versions
BEGIN SELECT RAISE(ABORT, 'published rule set version is immutable'); END;

CREATE TRIGGER template_published_content_immutable BEFORE UPDATE ON template_versions
WHEN OLD.approval_status IN ('approved','retired') AND (
  OLD.workspace_id <> NEW.workspace_id OR OLD.template_key <> NEW.template_key
  OR OLD.version_no <> NEW.version_no OR OLD.title <> NEW.title
  OR OLD.contract_type <> NEW.contract_type OR OLD.language <> NEW.language
  OR OLD.jurisdiction <> NEW.jurisdiction OR OLD.artifact_uri <> NEW.artifact_uri
  OR OLD.file_sha256 <> NEW.file_sha256 OR OLD.field_schema_json <> NEW.field_schema_json
  OR OLD.applicability_json <> NEW.applicability_json
  OR OLD.approved_by_label IS NOT NEW.approved_by_label OR OLD.approved_at IS NOT NEW.approved_at
  OR OLD.created_at <> NEW.created_at
)
BEGIN SELECT RAISE(ABORT, 'published template content is immutable; create a new template version'); END;

CREATE TRIGGER template_status_no_regression BEFORE UPDATE OF approval_status ON template_versions
WHEN (OLD.approval_status = 'approved' AND NEW.approval_status = 'draft')
  OR (OLD.approval_status = 'retired' AND NEW.approval_status <> 'retired')
BEGIN SELECT RAISE(ABORT, 'template approval status cannot regress'); END;

CREATE TRIGGER analysis_run_inputs_immutable BEFORE UPDATE ON analysis_runs
WHEN OLD.contract_id <> NEW.contract_id OR OLD.kind <> NEW.kind
  OR OLD.document_version_id IS NOT NEW.document_version_id
  OR OLD.template_version_id IS NOT NEW.template_version_id
  OR OLD.rule_set_version_id <> NEW.rule_set_version_id
  OR OLD.model_provider_profile_id <> NEW.model_provider_profile_id
  OR OLD.jurisdiction <> NEW.jurisdiction OR OLD.our_party_role <> NEW.our_party_role
  OR OLD.report_language <> NEW.report_language OR OLD.input_snapshot_json <> NEW.input_snapshot_json
  OR OLD.model_snapshot_json <> NEW.model_snapshot_json OR OLD.prompt_snapshot_json <> NEW.prompt_snapshot_json
  OR OLD.retrieval_policy_snapshot_json <> NEW.retrieval_policy_snapshot_json
  OR OLD.applied_memory_revision_ids_json <> NEW.applied_memory_revision_ids_json
  OR OLD.input_fingerprint <> NEW.input_fingerprint OR OLD.supersedes_run_id IS NOT NEW.supersedes_run_id
BEGIN SELECT RAISE(ABORT, 'analysis input snapshot is immutable; create a new run'); END;

CREATE TRIGGER evidence_source_immutable BEFORE UPDATE ON evidence
WHEN OLD.analysis_run_id <> NEW.analysis_run_id OR OLD.retrieval_attempt_id IS NOT NEW.retrieval_attempt_id
  OR OLD.origin <> NEW.origin OR OLD.external_source_id IS NOT NEW.external_source_id
  OR OLD.source_url IS NOT NEW.source_url OR OLD.source_locator_json <> NEW.source_locator_json
  OR OLD.original_excerpt <> NEW.original_excerpt OR OLD.excerpt_sha256 <> NEW.excerpt_sha256
  OR OLD.language <> NEW.language OR OLD.source_version IS NOT NEW.source_version
BEGIN SELECT RAISE(ABORT, 'evidence source snapshot is immutable; create a new evidence record'); END;

CREATE TRIGGER dispositions_no_update BEFORE UPDATE ON dispositions
BEGIN SELECT RAISE(ABORT, 'disposition history is append-only'); END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit history is append-only'); END;

CREATE TRIGGER memory_revision_content_immutable BEFORE UPDATE ON memory_revisions
WHEN OLD.memory_id <> NEW.memory_id OR OLD.version_no <> NEW.version_no
  OR OLD.content_json <> NEW.content_json OR OLD.content_sha256 <> NEW.content_sha256
  OR OLD.source_feedback_id IS NOT NEW.source_feedback_id
BEGIN SELECT RAISE(ABORT, 'memory content changes require a new revision'); END;

CREATE TRIGGER memory_revision_approval_final BEFORE UPDATE ON memory_revisions
WHEN OLD.approval_status = 'approved' AND (
  NEW.approval_status <> 'approved' OR OLD.approved_by_label IS NOT NEW.approved_by_label
  OR OLD.approved_at IS NOT NEW.approved_at
)
BEGIN SELECT RAISE(ABORT, 'approved revision is final; revoke memory or create a new revision'); END;

CREATE TRIGGER memories_activate_approved BEFORE UPDATE OF status, current_revision_id ON memories
WHEN NEW.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM memory_revisions r
  WHERE r.id = NEW.current_revision_id AND r.memory_id = NEW.id AND r.approval_status = 'approved'
)
BEGIN SELECT RAISE(ABORT, 'active memory requires its own approved revision'); END;

CREATE TRIGGER memories_insert_active BEFORE INSERT ON memories
WHEN NEW.status = 'active'
BEGIN SELECT RAISE(ABORT, 'insert candidate memory first, then approve revision and activate'); END;

CREATE TRIGGER changes_match_source_insert BEFORE INSERT ON change_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM document_blocks b
  WHERE b.id = NEW.document_block_id AND b.document_version_id = NEW.source_document_version_id
)
BEGIN SELECT RAISE(ABORT, 'change anchor does not belong to source document version'); END;

CREATE TRIGGER changes_anchor_immutable BEFORE UPDATE ON change_proposals
WHEN OLD.source_document_version_id <> NEW.source_document_version_id
  OR OLD.document_block_id <> NEW.document_block_id
  OR OLD.range_start <> NEW.range_start OR OLD.range_end <> NEW.range_end
  OR OLD.expected_original_text <> NEW.expected_original_text
  OR OLD.expected_original_text_sha256 <> NEW.expected_original_text_sha256
BEGIN SELECT RAISE(ABORT, 'change source anchor is immutable'); END;

CREATE TRIGGER reports_inputs_immutable BEFORE UPDATE ON reports
WHEN OLD.workspace_id <> NEW.workspace_id OR OLD.report_key <> NEW.report_key
  OR OLD.version_no <> NEW.version_no OR OLD.kind <> NEW.kind OR OLD.language <> NEW.language
  OR OLD.input_manifest_json <> NEW.input_manifest_json
BEGIN SELECT RAISE(ABORT, 'report source manifest is immutable; create a new report version'); END;

CREATE TRIGGER reports_reviewed_content_immutable BEFORE UPDATE ON reports
WHEN OLD.status IN ('reviewed','exported') AND OLD.content_json <> NEW.content_json
BEGIN SELECT RAISE(ABORT, 'reviewed report content is immutable; create a new report version'); END;

CREATE TRIGGER reports_status_no_regression BEFORE UPDATE OF status ON reports
WHEN (OLD.status = 'reviewed' AND NEW.status = 'draft')
  OR (OLD.status = 'exported' AND NEW.status <> 'exported')
BEGIN SELECT RAISE(ABORT, 'report status cannot regress'); END;

CREATE TRIGGER reports_exported_artifact_immutable BEFORE UPDATE ON reports
WHEN OLD.status = 'exported' AND (
  OLD.artifact_uri IS NOT NEW.artifact_uri OR OLD.file_sha256 IS NOT NEW.file_sha256
)
BEGIN SELECT RAISE(ABORT, 'exported report artifact is immutable; create a new report version'); END;

-- 下列跨实体关系与 JSON 内部引用由应用服务事务校验：工作区一致、run/issue/evidence
-- 同批次、模板已批准、provider kind 正确、记忆适用范围、报告来源清单一致。
-- 应用补充校验：文档范围/字符计数/hash、重叠补丁、文件路径、端点策略、秘密字段排除。
-- 关闭/停用/撤销通过状态与新版本记录；物理删除由工作区清理事务按依赖顺序完成。
-- 清理须同步管理文件及衍生缓存，不能把本地日志当作防篡改司法存证。

INSERT INTO schema_version(version, applied_at) VALUES (1, '2026-10-22T00:00:00Z');
COMMIT;
