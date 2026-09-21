import { describe, expect, it } from 'vitest';
import { DagScheduler, validateDag, type DagTask } from '../../src/harness/dag-scheduler.js';

const task = (id: string, dependencies: string[] = []): DagTask => ({
  id,
  title: id,
  description: `Implement ${id}`,
  dependencies,
  worker: 'codex',
  files: [],
  risk: 'medium',
});

describe('DagScheduler', () => {
  it('runs independent roots in parallel and unlocks dependents only after success', () => {
    const dag = new DagScheduler([task('T1'), task('T2'), task('T3', ['T1', 'T2'])]);
    expect(dag.ready().map((item) => item.id)).toEqual(['T1', 'T2']);
    dag.start('T1', 'codex-1');
    dag.start('T2', 'codex-2');
    dag.succeed('T1');
    expect(dag.ready()).toEqual([]);
    dag.succeed('T2');
    expect(dag.ready().map((item) => item.id)).toEqual(['T3']);
  });

  it('skips downstream tasks after a dependency fails', () => {
    const dag = new DagScheduler([task('T1'), task('T2', ['T1'])]);
    dag.start('T1', 'codex-1');
    dag.fail('T1', 'failed');
    expect(dag.snapshot().find((item) => item.id === 'T2')?.state).toBe('SKIPPED');
    expect(dag.isComplete()).toBe(true);
  });

  it('rejects dependency cycles before execution', () => {
    expect(() => validateDag([task('T1', ['T2']), task('T2', ['T1'])])).toThrow(/cycle/);
  });

  it('rejects missing dependencies', () => {
    expect(() => validateDag([task('T1', ['missing'])])).toThrow(/unknown task/);
  });
});
