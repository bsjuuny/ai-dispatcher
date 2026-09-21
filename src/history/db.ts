import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as NodeSqliteModule from 'node:sqlite';

// Both static AND dynamic `import ... from 'node:sqlite'` get rewritten by esbuild
// to the bare specifier `sqlite` (a nonexistent npm package) - verified directly
// against dist output, with platform:'node' and explicit `external` config making no
// difference. `process.getBuiltinModule()` (Node 22+) is a plain runtime function
// call with a string argument, invisible to esbuild's static import-graph analysis,
// so it isn't subject to the same rewrite.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqliteModule;
export type DatabaseSync = NodeSqliteModule.DatabaseSync;

/**
 * node:sqlite (not better-sqlite3) - verified live to work on the installed Node
 * v24.14.0 build with zero native compilation, which matters because this machine
 * has no MSVC/cl.exe toolchain and no admin rights. It's Node's "Experimental" API
 * tier; every SQLite call is isolated behind this file + repository.ts so a future
 * swap is a two-file change, not a rewrite. See docs/architecture.md.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    task_type TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    fallback_count INTEGER NOT NULL DEFAULT 0,
    validation_passed INTEGER,
    review_verdict TEXT,
    input_size INTEGER,
    output_size INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    FOREIGN KEY (task_id) REFERENCES tasks (task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_executions_task_id ON executions (task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events (task_id)`,
  `CREATE TABLE IF NOT EXISTS harness_task_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  )`,
  `CREATE TABLE IF NOT EXISTS harness_tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_length INTEGER NOT NULL,
    project_root TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    last_safe_phase TEXT NOT NULL,
    route TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retry INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error_code TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS harness_phase_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    from_phase TEXT NOT NULL,
    to_phase TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES harness_tasks (task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_tasks_updated_at ON harness_tasks (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_harness_phase_events_task_id ON harness_phase_events (task_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS harness_agent_calls (
    call_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    actual_cost REAL,
    source TEXT NOT NULL,
    billing_mode TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES harness_tasks (task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_agent_calls_task_id ON harness_agent_calls (task_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS harness_agent_activity (
    call_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES harness_tasks (task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_agent_activity_task_id ON harness_agent_activity (task_id, started_at)`,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  return db;
}

export function defaultHistoryDbPath(projectRoot: string): string {
  return `${projectRoot}/.dispatcher/history.sqlite`;
}

export function defaultHarnessStateDbPath(projectRoot: string): string {
  return `${projectRoot}/.ai-harness/state.sqlite`;
}
