import { describe, expect, it } from 'vitest';
import { CodexWorkerPool } from '../../src/harness/codex-worker-pool.js';
import type { AgentRuntime, HarnessAgentRequest, HarnessAgentResult } from '../../src/harness/agent-runtime.js';
import type { DagTask } from '../../src/harness/dag-scheduler.js';

const task = (id: string, dependencies: string[] = []): DagTask => ({
  id,
  title: id,
  description: id,
  dependencies,
  worker: 'codex',
  files: [`${id}.ts`],
  risk: 'low',
});

class FakeRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  calls: HarnessAgentRequest[] = [];
  constructor(private readonly failName?: string) {}

  async run(request: HarnessAgentRequest): Promise<HarnessAgentResult> {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    if (request.prompt.includes(this.failName ?? '__never__')) throw new Error('implementation failed');
    return { name: request.name, state: 'done', output: 'ok', workspaceId: 'w1', paneId: 'p1' };
  }
}

describe('CodexWorkerPool', () => {
  it('executes independent tasks concurrently within the worker budget', async () => {
    const runtime = new FakeRuntime();
    const result = await new CodexWorkerPool(runtime).execute({
      tasks: [task('T1'), task('T2'), task('T3', ['T1', 'T2'])],
      workerCount: 2,
      timeoutMs: 1000,
      resolveWorkingDirectory: (item) => `C:/worktrees/${item.id}`,
    });
    expect(result.succeeded).toBe(true);
    expect(result.maxParallelObserved).toBe(2);
    expect(runtime.maxActive).toBe(2);
    expect(runtime.calls[2]?.workingDirectory).toBe('C:/worktrees/T3');
  });

  it('marks dependents skipped when a worker fails', async () => {
    const result = await new CodexWorkerPool(new FakeRuntime('T1')).execute({
      tasks: [task('T1'), task('T2', ['T1'])],
      workerCount: 2,
      timeoutMs: 1000,
      resolveWorkingDirectory: () => 'C:/worktree',
    });
    expect(result.succeeded).toBe(false);
    expect(result.tasks.map((item) => [item.id, item.state])).toEqual([['T1', 'FAILED'], ['T2', 'SKIPPED']]);
  });
});
