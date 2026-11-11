/**
 * Embedded SQL migrations. They ship inside the bundle, so Orbit never has to
 * locate a migrations folder on disk at runtime. Append new migrations; never
 * edit one that has been released.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  github_owner TEXT,
  github_repo TEXT,
  default_branch TEXT NOT NULL,
  allow_modify INTEGER NOT NULL DEFAULT 1,
  setup_commands TEXT NOT NULL DEFAULT '[]',
  verify_commands TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  summary_head_sha TEXT,
  summary_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  account_user_id TEXT,
  account_name TEXT,
  account_email TEXT,
  auth_type TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE authorized_users (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX authorized_users_unique ON authorized_users(integration_id, external_user_id);

CREATE TABLE external_projects (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  workspace_id TEXT,
  workspace_name TEXT,
  name TEXT NOT NULL,
  url TEXT,
  triggers_enabled INTEGER NOT NULL DEFAULT 1,
  sync_token TEXT,
  last_polled_at TEXT,
  last_event_at TEXT,
  last_reconciled_at TEXT,
  poll_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX external_projects_unique ON external_projects(integration_id, external_id);

CREATE TABLE project_repos (
  project_id TEXT NOT NULL REFERENCES external_projects(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repo_id)
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_task_id TEXT,
  source_project_id TEXT,
  source_url TEXT,
  integration_id TEXT,
  entry_point TEXT NOT NULL,
  triggered_by TEXT,
  trigger_verified INTEGER NOT NULL DEFAULT 0,
  current_revision INTEGER NOT NULL DEFAULT 1,
  requirements_changed_at TEXT,
  plan TEXT,
  blocked_reason TEXT,
  last_error TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  runtime TEXT,
  active_key TEXT,
  requested_repo_ids TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX missions_status ON missions(status);
CREATE INDEX missions_source ON missions(source_provider, source_task_id);
-- At most one non-terminal mission per external task.
CREATE UNIQUE INDEX missions_active_key ON missions(active_key) WHERE active_key IS NOT NULL;

CREATE TABLE mission_revisions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  comments TEXT NOT NULL,
  extra_instructions TEXT,
  source_updated_at TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mission_revisions_unique ON mission_revisions(mission_id, revision);

CREATE TABLE mission_repos (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  selection TEXT,
  branch TEXT,
  base_branch TEXT,
  base_sha TEXT,
  worktree_path TEXT,
  head_sha TEXT,
  commit_sha TEXT,
  diff_stats TEXT,
  engineer_summary TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_title TEXT,
  pr_body TEXT,
  pr_base TEXT,
  pr_state TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mission_repos_unique ON mission_repos(mission_id, repo_id);

CREATE TABLE mission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  mission_repo_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  data TEXT
);
CREATE INDEX mission_events_mission ON mission_events(mission_id, id);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  mission_repo_id TEXT,
  role TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  cost_usd REAL,
  usage TEXT,
  num_turns INTEGER,
  session_id TEXT,
  summary TEXT,
  error TEXT
);
CREATE INDEX agent_runs_mission ON agent_runs(mission_id);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  mission_repo_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_tail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX verifications_mission ON verifications(mission_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  mission_repo_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings TEXT NOT NULL,
  criteria TEXT NOT NULL,
  agent_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX reviews_mission ON reviews(mission_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  mission_repo_id TEXT,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  notes TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX approvals_mission ON approvals(mission_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mission_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX jobs_claim ON jobs(status, run_at, priority);
-- One queued or running job per dedupe key.
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  integration_id TEXT,
  project_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  external_task_id TEXT NOT NULL,
  external_user_id TEXT,
  external_user_name TEXT,
  command TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reason TEXT,
  mission_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE side_effects (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  mission_repo_id TEXT,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  request TEXT,
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);
`,
  },
  {
    id: '0002_setup_artifacts',
    sql: `ALTER TABLE mission_repos ADD COLUMN setup_artifacts TEXT;`,
  },
  {
    id: '0003_blocked_code',
    sql: `ALTER TABLE missions ADD COLUMN blocked_code TEXT;`,
  },
  {
    id: '0004_reference_repos',
    sql: `ALTER TABLE missions ADD COLUMN reference_repo_ids TEXT;`,
  },
  {
    id: '0005_plain_folders',
    sql: `ALTER TABLE repos ADD COLUMN is_git INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    id: '0006_conversations',
    sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repo_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_updated ON conversations(updated_at);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  runtime TEXT,
  model TEXT,
  error TEXT,
  suggestion TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX conversation_messages_conv ON conversation_messages(conversation_id, created_at);

CREATE TABLE conversation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  data TEXT
);
CREATE INDEX conversation_events_conv ON conversation_events(conversation_id, id);
`,
  },
  {
    id: '0007_working_sessions',
    sql: `
ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE conversations ADD COLUMN agent_session_id TEXT;
ALTER TABLE conversations ADD COLUMN agent_runtime TEXT;
ALTER TABLE conversations ADD COLUMN allowed_commands TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversation_messages ADD COLUMN blocked TEXT;
ALTER TABLE conversations ADD COLUMN seat TEXT NOT NULL DEFAULT 'assistant';
ALTER TABLE reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'quality';
`,
  },
  {
    id: '0008_session_permission_mode',
    sql: `ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';`,
  },
  {
    id: '0009_session_model',
    sql: `ALTER TABLE conversations ADD COLUMN model TEXT;`,
  },
  {
    id: '0010_session_effort',
    sql: `ALTER TABLE conversations ADD COLUMN effort TEXT;`,
  },
  {
    id: '0011_message_attachments',
    sql: `ALTER TABLE conversation_messages ADD COLUMN attachments TEXT;`,
  },
  {
    id: '0012_session_usage_checkpoints_compact',
    sql: `
ALTER TABLE conversation_messages ADD COLUMN usage TEXT;
ALTER TABLE conversation_messages ADD COLUMN checkpoint TEXT;
ALTER TABLE conversations ADD COLUMN compact_from TEXT;
`,
  },
  {
    id: '0013_plan_message_kind',
    sql: `ALTER TABLE conversation_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';`,
  },
];
