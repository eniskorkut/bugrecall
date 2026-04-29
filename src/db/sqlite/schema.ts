export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "0001_core_tables",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  git_remote_hash TEXT,
  initial_commit_hash TEXT,
  workspace_relative_path TEXT NOT NULL,
  manifest_fingerprint TEXT,
  display_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_profiles (
  project_id TEXT PRIMARY KEY,
  languages_json TEXT NOT NULL,
  frameworks_json TEXT NOT NULL,
  package_manager TEXT,
  test_command_json TEXT,
  lint_command_json TEXT,
  build_command_json TEXT,
  typecheck_command_json TEXT,
  profile_version INTEGER DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_vectorization',
  confidence REAL DEFAULT 1.0,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_retrieved_at DATETIME,
  retrieval_hits INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_text TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_budget_json TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS patch_history (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  search_block TEXT NOT NULL,
  replace_block TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  success_flag INTEGER NOT NULL,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_blob BLOB NOT NULL,
  compression TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`,
  },
  {
    id: "0002_embedding_cache",
    sql: `
CREATE TABLE IF NOT EXISTS embedding_cache (
  record_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`,
  },
  {
    id: "0003_task_attempts",
    sql: `
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  success_flag INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`,
  },
];
