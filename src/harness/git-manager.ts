import { resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DispatcherError } from '../models/error.js';
import { runProcess } from '../process/process-runner.js';
import type { ProcessExecutor } from './herdr-adapter.js';

export interface TaskWorktrees {
  taskId: string;
  integrationBranch: string;
  integrationPath: string;
  baseRef: string;
}

export interface SubtaskWorktree {
  taskId: string;
  subtaskId: string;
  branch: string;
  path: string;
}

export interface MergeResult {
  status: 'MERGED' | 'CONFLICT';
  stdout: string;
  stderr: string;
}

export class HarnessGitManager {
  private readonly integrationQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly projectRoot: string,
    private readonly worktreeRoot: string,
    private readonly execute: ProcessExecutor = runProcess,
  ) {}

  async assertRepository(): Promise<void> {
    const result = await this.git(['rev-parse', '--show-toplevel'], this.projectRoot);
    if (result.exitCode !== 0) {
      throw new DispatcherError({ code: 'GIT_REPO_MISSING', message: `${this.projectRoot} is not a Git repository.`, retryable: false });
    }
  }

  async resolveBaseRef(configured: string): Promise<string> {
    for (const candidate of [configured, 'main', 'master']) {
      const result = await this.git(['rev-parse', '--verify', candidate], this.projectRoot);
      if (result.exitCode === 0) return candidate;
    }
    throw new DispatcherError({ code: 'GIT_REPO_MISSING', message: 'No configured, main, or master base branch exists.', retryable: false });
  }

  async createTaskWorktree(taskId: string, configuredBase: string): Promise<TaskWorktrees> {
    await this.assertRepository();
    const baseRef = await this.resolveBaseRef(configuredBase);
    // Git refs cannot simultaneously contain `ai/TASK-001` and
    // `ai/TASK-001/T1` because one ref cannot also be a directory prefix.
    const integrationBranch = `ai/${taskId}/integration`;
    const integrationPath = this.safePath(taskId, 'integration');
    mkdirSync(resolve(integrationPath, '..'), { recursive: true });
    const result = await this.git(
      ['worktree', 'add', '-b', integrationBranch, integrationPath, baseRef],
      this.projectRoot,
      60_000,
    );
    if (result.exitCode !== 0) throw gitError('WORKTREE_CREATE_FAILED', result.stderr || result.stdout);
    return { taskId, integrationBranch, integrationPath, baseRef };
  }

  async createSubtaskWorktree(task: TaskWorktrees, subtaskId: string): Promise<SubtaskWorktree> {
    const branch = `ai/${task.taskId}/${sanitizeSegment(subtaskId)}`;
    const path = this.safePath(task.taskId, sanitizeSegment(subtaskId));
    const result = await this.git(['worktree', 'add', '-b', branch, path, task.integrationBranch], this.projectRoot, 60_000);
    if (result.exitCode !== 0) throw gitError('WORKTREE_CREATE_FAILED', result.stderr || result.stdout);
    return { taskId: task.taskId, subtaskId, branch, path };
  }

  async commitSubtask(worktree: SubtaskWorktree, message: string): Promise<string | undefined> {
    const status = await this.git(['status', '--porcelain'], worktree.path);
    if (!status.stdout.trim()) return undefined;
    await this.requireSuccess(['add', '--all'], worktree.path);
    await this.requireSuccess(['commit', '-m', message], worktree.path, 60_000);
    const revision = await this.requireSuccess(['rev-parse', 'HEAD'], worktree.path);
    return revision.stdout.trim();
  }

  async mergeSubtask(task: TaskWorktrees, subtask: SubtaskWorktree): Promise<MergeResult> {
    return this.withIntegrationLock(task.integrationPath, async () => {
      const result = await this.git(
        ['merge', '--no-ff', '--no-edit', subtask.branch],
        task.integrationPath,
        60_000,
      );
      if (result.exitCode === 0) return { status: 'MERGED', stdout: result.stdout, stderr: result.stderr };
      await this.git(['merge', '--abort'], task.integrationPath);
      return { status: 'CONFLICT', stdout: result.stdout, stderr: result.stderr };
    });
  }

  async diff(task: TaskWorktrees): Promise<string> {
    const result = await this.requireSuccess(['diff', `${task.baseRef}...HEAD`], task.integrationPath, 60_000);
    return result.stdout;
  }

  async changedFiles(task: TaskWorktrees): Promise<string[]> {
    const result = await this.requireSuccess(['diff', '--name-only', `${task.baseRef}...HEAD`], task.integrationPath, 60_000);
    return result.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  }

  async removeWorktree(path: string, force = false): Promise<void> {
    this.assertWithinRoot(path);
    const args = ['worktree', 'remove', path];
    if (force) args.push('--force');
    await this.requireSuccess(args, this.projectRoot, 60_000);
  }

  private safePath(taskId: string, leaf: string): string {
    if (!/^TASK-[A-Za-z0-9-]+$/.test(taskId)) throw gitError('SAFETY_POLICY_VIOLATION', 'Invalid task id.');
    const path = resolve(this.worktreeRoot, taskId, leaf);
    this.assertWithinRoot(path);
    return path;
  }

  private assertWithinRoot(path: string): void {
    const root = resolve(this.worktreeRoot);
    const target = resolve(path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw gitError('SAFETY_POLICY_VIOLATION', `Worktree path escapes configured root: ${target}`);
    }
  }

  private async requireSuccess(args: string[], cwd: string, timeoutMs = 30_000) {
    const result = await this.git(args, cwd, timeoutMs);
    if (result.exitCode !== 0) throw gitError('GIT_COMMAND_FAILED', result.stderr || result.stdout);
    return result;
  }

  private git(args: string[], cwd: string, timeoutMs = 30_000) {
    return this.execute({ file: 'git', args, cwd, timeoutMs });
  }

  private async withIntegrationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.integrationQueues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.integrationQueues.set(path, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.integrationQueues.get(path) === tail) this.integrationQueues.delete(path);
    }
  }
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '-');
  if (!sanitized) throw gitError('SAFETY_POLICY_VIOLATION', 'Invalid branch segment.');
  return sanitized;
}

function gitError(code: 'WORKTREE_CREATE_FAILED' | 'GIT_COMMAND_FAILED' | 'SAFETY_POLICY_VIOLATION', message: string) {
  return new DispatcherError({ code, message: message.trim(), retryable: code !== 'SAFETY_POLICY_VIOLATION' });
}
