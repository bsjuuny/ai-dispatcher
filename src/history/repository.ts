import type { DatabaseSync } from './db.js';
import type { DispatcherTask, TaskStatus } from '../models/task.js';
import type { ProviderId } from '../models/provider.js';
import type { AuditEvent, AuditSink } from '../logging/audit.js';
import type { UsageRecord, UsageStore } from '../routing/usage-store.js';
import { DispatcherError } from '../models/error.js';
import type { HarnessStateStore } from '../harness/state-store.js';
import type {
  CreateHarnessTaskInput,
  HarnessPhase,
  HarnessPhaseEvent,
  HarnessTaskPatch,
  HarnessTaskQuery,
  HarnessTaskRecord,
  HarnessTaskStatus,
} from '../harness/types.js';
import type { AgentCallRecord, AgentUsageSummary, HarnessTelemetryStore } from '../harness/telemetry.js';

/**
 * The only file with raw SQL in it - everything else gets typed functions. Doubles
 * as the SQLite-backed implementation of UsageStore and AuditSink so the routing and
 * logging layers never need to know history is SQLite-backed at all.
 */
export class HistoryRepository implements UsageStore, AuditSink, HarnessStateStore, HarnessTelemetryStore {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  recordTaskCreated(task: DispatcherTask): void {
    this.run(
      `INSERT INTO tasks (task_id, command, started_at, status, retry_count, fallback_count, input_size)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [task.id, task.command, task.createdAt, task.status, task.specification.rawDescription.length],
    );
  }

  updateTaskStatus(taskId: string, status: TaskStatus, extra: { errorCode?: string; endedAt?: string } = {}): void {
    this.run(`UPDATE tasks SET status = ?, error_code = COALESCE(?, error_code), ended_at = COALESCE(?, ended_at) WHERE task_id = ?`, [
      status,
      extra.errorCode ?? null,
      extra.endedAt ?? null,
      taskId,
    ]);
  }

  incrementRetryCount(taskId: string): void {
    this.run(`UPDATE tasks SET retry_count = retry_count + 1 WHERE task_id = ?`, [taskId]);
  }

  incrementFallbackCount(taskId: string): void {
    this.run(`UPDATE tasks SET fallback_count = fallback_count + 1 WHERE task_id = ?`, [taskId]);
  }

  recordValidationOutcome(taskId: string, passed: boolean): void {
    this.run(`UPDATE tasks SET validation_passed = ? WHERE task_id = ?`, [passed ? 1 : 0, taskId]);
  }

  recordReviewVerdict(taskId: string, verdict: string): void {
    this.run(`UPDATE tasks SET review_verdict = ? WHERE task_id = ?`, [verdict, taskId]);
  }

  recordExecution(params: {
    executionId: string;
    taskId: string;
    provider: ProviderId;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    status: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }): void {
    this.run(
      `INSERT INTO executions (execution_id, task_id, provider, started_at, finished_at, duration_ms, status, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.executionId,
        params.taskId,
        params.provider,
        params.startedAt,
        params.finishedAt,
        params.durationMs,
        params.status,
        params.inputTokens ?? null,
        params.outputTokens ?? null,
        params.costUsd ?? null,
      ],
    );
  }

  queryHistory(limit = 50): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?`);
    return stmt.all(limit) as Array<Record<string, unknown>>;
  }

  getTask(taskId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`);
    return stmt.get(taskId) as Record<string, unknown> | undefined;
  }

  getExecutionsForTask(taskId: string): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ORDER BY started_at ASC`);
    return stmt.all(taskId) as Array<Record<string, unknown>>;
  }

  getAuditEventsForTask(taskId: string): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`SELECT * FROM audit_events WHERE task_id = ? ORDER BY sequence ASC`);
    return stmt.all(taskId) as Array<Record<string, unknown>>;
  }

  // --- HarnessStateStore ---

  create(input: CreateHarnessTaskInput): HarnessTaskRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sequence = this.db.prepare('INSERT INTO harness_task_sequence DEFAULT VALUES').run();
      const id = `TASK-${String(Number(sequence.lastInsertRowid)).padStart(3, '0')}`;
      this.run(
        `INSERT INTO harness_tasks (
          task_id, title, request_hash, request_length, project_root, status, phase,
          last_safe_phase, retry_count, max_retry, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'CREATED', 'CREATED', 'CREATED', 0, ?, ?, ?, '{}')`,
        [
          id,
          `Task ${id}`,
          input.requestHash,
          input.requestLength,
          input.projectRoot,
          input.maxRetry,
          input.createdAt,
          input.createdAt,
        ],
      );
      this.db.exec('COMMIT');
      return this.getHarnessTask(id)!;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      if (cause instanceof DispatcherError) throw cause;
      throw this.historyError(cause);
    }
  }

  get(taskId: string): HarnessTaskRecord | undefined {
    return this.getHarnessTask(taskId);
  }

  list(query: HarnessTaskQuery = {}): HarnessTaskRecord[] {
    const limit = query.limit ?? 100;
    const rows = query.status
      ? this.db
          .prepare('SELECT * FROM harness_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
          .all(query.status, limit)
      : this.db.prepare('SELECT * FROM harness_tasks ORDER BY updated_at DESC LIMIT ?').all(limit);
    return (rows as Array<Record<string, unknown>>).map(toHarnessTask);
  }

  update(taskId: string, patch: HarnessTaskPatch, event?: HarnessPhaseEvent): HarnessTaskRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getHarnessTask(taskId);
      if (!current) {
        throw new DispatcherError({
          code: 'TASK_NOT_FOUND',
          message: `Harness task not found: ${taskId}`,
          retryable: false,
          taskId,
        });
      }
      const next = {
        ...current,
        ...patch,
        errorCode: patch.errorCode === null ? undefined : (patch.errorCode ?? current.errorCode),
      };
      this.run(
        `UPDATE harness_tasks SET title = ?, status = ?, phase = ?, last_safe_phase = ?, route = ?,
         retry_count = ?, updated_at = ?, error_code = ?, metadata_json = ? WHERE task_id = ?`,
        [
          next.title,
          next.status,
          next.phase,
          next.lastSafePhase,
          next.route ?? null,
          next.retry,
          next.updatedAt,
          next.errorCode ?? null,
          JSON.stringify(next.metadata),
          taskId,
        ],
      );
      if (event) {
        this.run(
          `INSERT INTO harness_phase_events (task_id, from_phase, to_phase, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [event.taskId, event.fromPhase, event.toPhase, event.status, event.createdAt],
        );
      }
      this.db.exec('COMMIT');
      return this.getHarnessTask(taskId)!;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      if (cause instanceof DispatcherError) throw cause;
      throw this.historyError(cause);
    }
  }

  delete(taskId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM harness_agent_calls WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM harness_phase_events WHERE task_id = ?').run(taskId);
      const result = this.db.prepare('DELETE FROM harness_tasks WHERE task_id = ?').run(taskId);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw this.historyError(cause);
    }
  }

  recordAgentCall(record: AgentCallRecord): void {
    this.run(
      `INSERT INTO harness_agent_calls (
        call_id, task_id, agent, provider, started_at, finished_at, duration_ms, status,
        input_tokens, output_tokens, cached_tokens, actual_cost, source, billing_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.callId, record.taskId, record.agent, record.provider, record.startedAt, record.finishedAt,
        record.durationMs, record.status, record.inputTokens ?? null, record.outputTokens ?? null,
        record.cachedTokens ?? null, record.actualCost ?? null, record.source, record.billingMode],
    );
  }

  getAgentUsageSummary(taskId: string): AgentUsageSummary {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total_calls,
        COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
        SUM(CASE WHEN provider = 'claude' THEN 1 ELSE 0 END) AS claude_calls,
        SUM(CASE WHEN provider = 'codex' THEN 1 ELSE 0 END) AS codex_calls,
        SUM(CASE WHEN provider = 'jev' THEN 1 ELSE 0 END) AS jev_calls,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cached_tokens) AS cached_tokens,
        SUM(actual_cost) AS actual_cost
       FROM harness_agent_calls WHERE task_id = ?`,
    ).get(taskId) as Record<string, unknown>;
    return {
      taskId,
      totalCalls: Number(row['total_calls']),
      totalDurationMs: Number(row['total_duration_ms']),
      claudeCalls: Number(row['claude_calls']),
      codexCalls: Number(row['codex_calls']),
      jevCalls: Number(row['jev_calls']),
      inputTokens: nullableNumber(row['input_tokens']),
      outputTokens: nullableNumber(row['output_tokens']),
      cachedTokens: nullableNumber(row['cached_tokens']),
      actualCost: nullableNumber(row['actual_cost']),
    };
  }

  private getHarnessTask(taskId: string): HarnessTaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM harness_tasks WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? toHarnessTask(row) : undefined;
  }

  // --- UsageStore ---

  async record(entry: UsageRecord): Promise<void> {
    this.recordExecution({
      executionId: entry.executionId,
      taskId: entry.taskId,
      provider: entry.provider,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      status: entry.outcome,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
    });
  }

  async recentFor(provider: ProviderId, windowMs: number, now: Date = new Date()): Promise<UsageRecord[]> {
    const cutoffIso = Number.isFinite(windowMs)
      ? new Date(now.getTime() - windowMs).toISOString()
      : '0000-01-01T00:00:00.000Z';
    const stmt = this.db.prepare(
      `SELECT * FROM executions WHERE provider = ? AND finished_at >= ? ORDER BY finished_at ASC`,
    );
    const rows = stmt.all(provider, cutoffIso) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: row['provider'] as ProviderId,
      taskId: row['task_id'] as string,
      executionId: row['execution_id'] as string,
      outcome: row['status'] as UsageRecord['outcome'],
      startedAt: row['started_at'] as string,
      finishedAt: row['finished_at'] as string,
      durationMs: row['duration_ms'] as number,
      inputTokens: (row['input_tokens'] as number | null) ?? undefined,
      outputTokens: (row['output_tokens'] as number | null) ?? undefined,
      costUsd: (row['cost_usd'] as number | null) ?? undefined,
    }));
  }

  // --- AuditSink ---

  async append(event: AuditEvent): Promise<void> {
    this.run(`INSERT INTO audit_events (event_id, task_id, sequence, type, timestamp, data_json) VALUES (?, ?, ?, ?, ?, ?)`, [
      event.eventId,
      event.taskId,
      event.sequence,
      event.type,
      event.timestamp,
      JSON.stringify(event.data),
    ]);
    if (event.type === 'retry.started') this.incrementRetryCount(event.taskId);
    if (event.type === 'fallback.started') this.incrementFallbackCount(event.taskId);
  }

  private run(sql: string, params: unknown[]): void {
    try {
      this.db.prepare(sql).run(...(params as never[]));
    } catch (cause) {
      throw new DispatcherError({
        code: 'HISTORY_WRITE_FAILED',
        message: `History write failed: ${(cause as Error).message}`,
        cause,
        retryable: false,
      });
    }
  }

  private historyError(cause: unknown): DispatcherError {
    return new DispatcherError({
      code: 'HISTORY_WRITE_FAILED',
      message: `History write failed: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }
}

function toHarnessTask(row: Record<string, unknown>): HarnessTaskRecord {
  return {
    id: row['task_id'] as string,
    title: row['title'] as string,
    requestHash: row['request_hash'] as string,
    requestLength: row['request_length'] as number,
    projectRoot: row['project_root'] as string,
    status: row['status'] as HarnessTaskStatus,
    phase: row['phase'] as HarnessPhase,
    lastSafePhase: row['last_safe_phase'] as HarnessPhase,
    route: (row['route'] as string | null) ?? undefined,
    retry: row['retry_count'] as number,
    maxRetry: row['max_retry'] as number,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    errorCode: (row['error_code'] as string | null) ?? undefined,
    metadata: JSON.parse(row['metadata_json'] as string) as Record<string, unknown>,
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
