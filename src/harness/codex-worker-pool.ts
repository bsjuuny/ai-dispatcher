import type { AgentRuntime } from './agent-runtime.js';
import { DagScheduler, type DagTask, type DagTaskSnapshot } from './dag-scheduler.js';

export interface CodexWorkAssignment {
  task: DagTask;
  workerName: string;
  workingDirectory: string;
}

export interface CodexWorkerPoolResult {
  tasks: DagTaskSnapshot[];
  succeeded: boolean;
  maxParallelObserved: number;
}

export class CodexWorkerPool {
  constructor(private readonly runtime: AgentRuntime) {}

  async execute(input: {
    tasks: DagTask[];
    workerCount: number;
    timeoutMs: number;
    resolveWorkingDirectory: (task: DagTask) => string;
    onUpdate?: (tasks: DagTaskSnapshot[]) => void;
  }): Promise<CodexWorkerPoolResult> {
    const scheduler = new DagScheduler(input.tasks);
    let maxParallelObserved = 0;
    while (!scheduler.isComplete()) {
      const ready = scheduler.ready(input.workerCount);
      if (ready.length === 0) break;
      maxParallelObserved = Math.max(maxParallelObserved, ready.length);
      await Promise.all(
        ready.map(async (task, index) => {
          const workerName = `codex-${index + 1}`;
          scheduler.start(task.id, workerName);
          input.onUpdate?.(scheduler.snapshot());
          try {
            await this.runtime.run({
              name: workerName,
              kind: 'codex',
              workingDirectory: input.resolveWorkingDirectory(task),
              timeoutMs: input.timeoutMs,
              prompt: buildCodexPrompt(task),
            });
            scheduler.succeed(task.id);
          } catch (cause) {
            scheduler.fail(task.id, cause instanceof Error ? cause.message : String(cause));
          }
          input.onUpdate?.(scheduler.snapshot());
        }),
      );
    }
    return {
      tasks: scheduler.snapshot(),
      succeeded: !scheduler.hasFailures() && scheduler.isComplete(),
      maxParallelObserved,
    };
  }
}

function buildCodexPrompt(task: DagTask): string {
  return [
    `Implement DAG task ${task.id}: ${task.title}`,
    task.description,
    `Expected files: ${task.files.length ? task.files.join(', ') : 'discover the minimal relevant files'}`,
    'Work only in this assigned worktree. Do not change architecture decisions, disable tests, or make unrelated changes.',
    'Add or update tests appropriate to this subtask and report the commands run.',
  ].join('\n');
}
