import { DispatcherError } from '../models/error.js';

export type DagTaskState = 'PENDING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface DagTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  worker: 'codex';
  files: string[];
  risk: 'low' | 'medium' | 'high' | 'critical';
}

export interface DagTaskSnapshot extends DagTask {
  state: DagTaskState;
  workerName?: string;
  error?: string;
}

export class DagScheduler {
  private readonly tasks: Map<string, DagTaskSnapshot>;

  constructor(tasks: DagTask[]) {
    validateDag(tasks);
    this.tasks = new Map(tasks.map((task) => [task.id, { ...task, dependencies: [...task.dependencies], files: [...task.files], state: 'PENDING' }]));
    this.refresh();
  }

  snapshot(): DagTaskSnapshot[] {
    return [...this.tasks.values()].map((task) => ({ ...task, dependencies: [...task.dependencies], files: [...task.files] }));
  }

  ready(limit = Number.POSITIVE_INFINITY): DagTaskSnapshot[] {
    this.refresh();
    return this.snapshot().filter((task) => task.state === 'READY').slice(0, limit);
  }

  start(taskId: string, workerName: string): void {
    const task = this.required(taskId);
    if (task.state !== 'READY') throw invalidDagState(taskId, task.state, 'RUNNING');
    task.state = 'RUNNING';
    task.workerName = workerName;
  }

  succeed(taskId: string): void {
    const task = this.required(taskId);
    if (task.state !== 'RUNNING') throw invalidDagState(taskId, task.state, 'SUCCESS');
    task.state = 'SUCCESS';
    this.refresh();
  }

  fail(taskId: string, error: string): void {
    const task = this.required(taskId);
    if (task.state !== 'RUNNING') throw invalidDagState(taskId, task.state, 'FAILED');
    task.state = 'FAILED';
    task.error = error;
    this.refresh();
  }

  isComplete(): boolean {
    return this.snapshot().every((task) => ['SUCCESS', 'FAILED', 'SKIPPED'].includes(task.state));
  }

  hasFailures(): boolean {
    return this.snapshot().some((task) => task.state === 'FAILED' || task.state === 'SKIPPED');
  }

  private refresh(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) {
        if (task.state !== 'PENDING' && task.state !== 'BLOCKED' && task.state !== 'READY') continue;
        const dependencyStates = task.dependencies.map((id) => this.required(id).state);
        const next: DagTaskState = dependencyStates.some((state) => state === 'FAILED' || state === 'SKIPPED')
          ? 'SKIPPED'
          : dependencyStates.every((state) => state === 'SUCCESS')
            ? 'READY'
            : 'BLOCKED';
        if (task.state !== next) {
          task.state = next;
          changed = true;
        }
      }
    }
  }

  private required(taskId: string): DagTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new DispatcherError({ code: 'DAG_INVALID', message: `Unknown DAG task: ${taskId}`, retryable: false });
    }
    return task;
  }
}

export function validateDag(tasks: DagTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw dagError('DAG task ids must be unique.');
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw dagError(`Task ${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw dagError(`Task ${task.id} cannot depend on itself.`);
    }
  }
  const indegree = new Map(tasks.map((task) => [task.id, task.dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
  }
  const queue = tasks.filter((task) => task.dependencies.length === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== tasks.length) throw dagError('DAG contains a dependency cycle.');
}

function dagError(message: string): DispatcherError {
  return new DispatcherError({ code: 'DAG_INVALID', message, retryable: false });
}

function invalidDagState(taskId: string, from: DagTaskState, to: DagTaskState): DispatcherError {
  return new DispatcherError({
    code: 'INVALID_STATE_TRANSITION',
    message: `Cannot move DAG task ${taskId} from ${from} to ${to}.`,
    retryable: false,
  });
}
