import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DispatcherError } from '../models/error.js';

export interface WorkflowLease {
  taskId: string;
  token: string;
  path: string;
}

export class WorkflowLeaseManager {
  private readonly directory: string;

  constructor(projectRoot: string) {
    this.directory = join(projectRoot, '.ai-harness', 'locks');
  }

  acquire(taskId: string): WorkflowLease {
    if (!/^TASK-[A-Za-z0-9-]+$/.test(taskId)) throw locked(taskId, 'Invalid task id for workflow lease.');
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${taskId}.lock`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ taskId, token, pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
        } finally {
          closeSync(fd);
        }
        return { taskId, token, path };
      } catch (cause) {
        if (!isExistsError(cause)) throw cause;
        const owner = readOwner(path);
        if (owner && processIsAlive(owner.pid)) throw locked(taskId, `Task ${taskId} is already running in process ${owner.pid}.`);
        try {
          unlinkSync(path);
        } catch (unlinkCause) {
          throw locked(taskId, `Stale workflow lease could not be recovered: ${(unlinkCause as Error).message}`);
        }
      }
    }
    throw locked(taskId, `Could not acquire workflow lease for ${taskId}.`);
  }

  release(lease: WorkflowLease): void {
    const owner = readOwner(lease.path);
    if (!owner || owner.token !== lease.token) return;
    try {
      unlinkSync(lease.path);
    } catch (cause) {
      if (!isMissingError(cause)) throw cause;
    }
  }
}

function readOwner(path: string): { token: string; pid: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof value['token'] === 'string' && typeof value['pid'] === 'number'
      ? { token: value['token'], pid: value['pid'] }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isExistsError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissingError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === 'ENOENT';
}

function locked(taskId: string, message: string): DispatcherError {
  return new DispatcherError({ code: 'REPOSITORY_LOCKED', message, taskId, retryable: true });
}
