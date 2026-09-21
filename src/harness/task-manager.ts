import { hashContent } from '../logging/redaction.js';
import { DispatcherError } from '../models/error.js';
import type { HarnessStateStore } from './state-store.js';
import type { HarnessPhase, HarnessTaskQuery, HarnessTaskRecord, HarnessTaskStatus } from './types.js';

const TERMINAL_STATUSES = new Set<HarnessTaskStatus>(['COMPLETED', 'ABORTED']);

export class HarnessTaskManager {
  constructor(
    private readonly store: HarnessStateStore,
    private readonly maxRetry: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(request: string, projectRoot: string): HarnessTaskRecord {
    const normalized = request.trim();
    if (!normalized) {
      throw new DispatcherError({
        code: 'TASK_INPUT_EMPTY',
        message: 'Harness task must not be empty.',
        retryable: false,
      });
    }
    const createdAt = this.now().toISOString();
    return this.store.create({
      requestHash: hashContent(normalized),
      requestLength: normalized.length,
      projectRoot,
      maxRetry: this.maxRetry,
      createdAt,
    });
  }

  get(taskId: string): HarnessTaskRecord {
    const task = this.store.get(taskId);
    if (!task) {
      throw new DispatcherError({
        code: 'TASK_NOT_FOUND',
        message: `Harness task not found: ${taskId}`,
        retryable: false,
        taskId,
      });
    }
    return task;
  }

  list(query: HarnessTaskQuery = {}): HarnessTaskRecord[] {
    return this.store.list(query);
  }

  enterPhase(
    taskId: string,
    phase: HarnessPhase,
    options: { status?: HarnessTaskStatus; safeToResume?: boolean } = {},
  ): HarnessTaskRecord {
    const current = this.get(taskId);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw this.invalidTransition(taskId, current.status, phase);
    }
    const updatedAt = this.now().toISOString();
    const status = options.status ?? phaseStatus(phase);
    return this.store.update(
      taskId,
      {
        phase,
        status,
        lastSafePhase: options.safeToResume === false ? current.lastSafePhase : phase,
        updatedAt,
        errorCode: null,
      },
      { taskId, fromPhase: current.phase, toPhase: phase, status, createdAt: updatedAt },
    );
  }

  resume(taskId: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw this.invalidTransition(taskId, current.status, current.lastSafePhase);
    }
    return this.enterPhase(taskId, current.lastSafePhase, { status: 'RUNNING' });
  }

  retry(taskId: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (current.retry >= current.maxRetry) {
      return this.store.update(taskId, {
        status: 'FAILED',
        phase: 'FAILED',
        updatedAt: this.now().toISOString(),
        errorCode: 'MAX_RETRIES_EXCEEDED',
      });
    }
    const updated = this.store.update(taskId, {
      retry: current.retry + 1,
      status: 'RUNNING',
      updatedAt: this.now().toISOString(),
      errorCode: null,
    });
    return this.enterPhase(updated.id, updated.lastSafePhase, { status: 'RUNNING' });
  }

  abort(taskId: string): HarnessTaskRecord {
    return this.enterPhase(taskId, 'ABORTED', { status: 'ABORTED' });
  }

  finish(taskId: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (current.phase !== 'WAITING_HUMAN') {
      throw new DispatcherError({
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: `${taskId} can only be finished from WAITING_HUMAN.`,
        retryable: false,
        taskId,
      });
    }
    if (current.metadata['pullRequest']) {
      throw new DispatcherError({
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: `${taskId} has a pull request and must be completed by the verified merge action.`,
        retryable: false,
        taskId,
      });
    }
    return this.enterPhase(taskId, 'DONE', { status: 'COMPLETED' });
  }

  finishAfterVerifiedMerge(taskId: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (current.phase !== 'WAITING_HUMAN' || !current.metadata['pullRequest']) {
      throw new DispatcherError({
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: `${taskId} is not waiting for a verified pull-request merge.`,
        retryable: false,
        taskId,
      });
    }
    return this.enterPhase(taskId, 'DONE', { status: 'COMPLETED' });
  }

  requestMerge(taskId: string, revision: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (current.phase !== 'WAITING_HUMAN' || current.status !== 'WAITING' || !current.metadata['pullRequest']) {
      throw new DispatcherError({
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: `${taskId} is not ready for an explicit pull-request merge.`,
        retryable: false,
        taskId,
      });
    }
    return this.recordMetadata(taskId, {
      mergeIntent: { revision, requestedAt: this.now().toISOString() },
    });
  }

  fail(taskId: string, errorCode: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const updatedAt = this.now().toISOString();
    return this.store.update(
      taskId,
      { phase: 'FAILED', status: 'FAILED', updatedAt, errorCode },
      { taskId, fromPhase: current.phase, toPhase: 'FAILED', status: 'FAILED', createdAt: updatedAt },
    );
  }

  block(taskId: string, errorCode: string, budget = false): HarnessTaskRecord {
    const current = this.get(taskId);
    if (current.status === 'FAILED' || TERMINAL_STATUSES.has(current.status)) return current;
    return this.store.update(taskId, {
      status: budget ? 'BUDGET_BLOCKED' : 'BLOCKED',
      updatedAt: this.now().toISOString(),
      errorCode,
    });
  }

  recordRoute(taskId: string, route: Record<string, unknown> & { complexity: string }): HarnessTaskRecord {
    this.get(taskId);
    return this.store.update(taskId, {
      route: route.complexity,
      metadata: { route },
      updatedAt: this.now().toISOString(),
    });
  }

  recordMetadata(taskId: string, metadata: Record<string, unknown>): HarnessTaskRecord {
    this.get(taskId);
    return this.store.update(taskId, {
      metadata,
      updatedAt: this.now().toISOString(),
    });
  }

  wait(taskId: string, errorCode?: string): HarnessTaskRecord {
    const current = this.get(taskId);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    return this.store.update(taskId, {
      status: 'WAITING',
      updatedAt: this.now().toISOString(),
      errorCode: errorCode ?? current.errorCode ?? null,
    });
  }

  private invalidTransition(taskId: string, status: HarnessTaskStatus, phase: HarnessPhase): DispatcherError {
    return new DispatcherError({
      code: 'INVALID_STATE_TRANSITION',
      message: `Cannot move ${taskId} from terminal status ${status} to ${phase}.`,
      retryable: false,
      taskId,
    });
  }
}

function phaseStatus(phase: HarnessPhase): HarnessTaskStatus {
  if (phase === 'DONE') return 'COMPLETED';
  if (phase === 'FAILED') return 'FAILED';
  if (phase === 'ABORTED') return 'ABORTED';
  if (phase === 'WAITING_HUMAN' || phase === 'CI_WAIT') return 'WAITING';
  return phase === 'CREATED' ? 'CREATED' : 'RUNNING';
}
