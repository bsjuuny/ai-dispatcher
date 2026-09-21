import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/history/db.js';
import { HistoryRepository } from '../../src/history/repository.js';
import { HarnessTaskManager } from '../../src/harness/task-manager.js';

describe('HarnessTaskManager', () => {
  let tasks: HarnessTaskManager;

  beforeEach(() => {
    tasks = new HarnessTaskManager(
      new HistoryRepository(openDatabase(':memory:')),
      2,
      () => new Date('2026-09-22T00:00:00.000Z'),
    );
  });

  it('creates sequential persistent task ids without persisting the raw request', () => {
    const first = tasks.create('Fix login token refresh bug', 'C:/repo');
    const second = tasks.create('Another task', 'C:/repo');

    expect(first.id).toBe('TASK-001');
    expect(second.id).toBe('TASK-002');
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('login token');
  });

  it('resumes from the last safe phase instead of repeating an unsafe phase', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    tasks.enterPhase(task.id, 'PLANNING');
    tasks.enterPhase(task.id, 'CODEX_IMPLEMENT', { safeToResume: false });

    const resumed = tasks.resume(task.id);
    expect(resumed.phase).toBe('PLANNING');
    expect(resumed.status).toBe('RUNNING');
  });

  it('enforces the retry budget', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    tasks.retry(task.id);
    tasks.retry(task.id);
    const blocked = tasks.retry(task.id);

    expect(blocked.status).toBe('FAILED');
    expect(blocked.errorCode).toBe('MAX_RETRIES_EXCEEDED');
  });

  it('does not resume a completed task', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    tasks.enterPhase(task.id, 'WAITING_HUMAN');
    tasks.finish(task.id);
    expect(() => tasks.resume(task.id)).toThrow(/terminal status COMPLETED/);
  });

  it('does not allow finish to bypass quality and the human gate', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    expect(() => tasks.finish(task.id)).toThrow(/WAITING_HUMAN/);
  });

  it('does not let a late workflow failure overwrite an explicit abort', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    tasks.enterPhase(task.id, 'CODEX_IMPLEMENT');
    const aborted = tasks.abort(task.id);
    expect(tasks.fail(task.id, 'PROCESS_EXIT_ERROR')).toEqual(aborted);
    expect(tasks.block(task.id, 'AGENT_BLOCKED')).toEqual(aborted);
    expect(tasks.wait(task.id, 'CI_CHECK_PENDING')).toEqual(aborted);
    expect(tasks.get(task.id)).toMatchObject({ status: 'ABORTED', phase: 'ABORTED' });
  });

  it('records merge intent only at the explicit human gate', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    expect(() => tasks.requestMerge(task.id, 'abc123')).toThrow(/not ready/);
    tasks.recordMetadata(task.id, { pullRequest: { number: 7 } });
    tasks.enterPhase(task.id, 'WAITING_HUMAN', { status: 'WAITING' });
    expect(tasks.requestMerge(task.id, 'abc123').metadata['mergeIntent']).toMatchObject({ revision: 'abc123' });
  });

  it('preserves an exhausted retry failure instead of rewriting it as blocked', () => {
    const task = tasks.create('Implement feature', 'C:/repo');
    tasks.retry(task.id);
    tasks.retry(task.id);
    tasks.retry(task.id);
    const result = tasks.block(task.id, 'FINAL_GATE_STOP');
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MAX_RETRIES_EXCEEDED' });
  });
});
