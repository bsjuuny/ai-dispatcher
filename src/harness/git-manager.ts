import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
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
    const sourceStatus = await this.git(['status', '--porcelain'], this.projectRoot);
    if (sourceStatus.exitCode !== 0) throw gitError('GIT_COMMAND_FAILED', sourceStatus.stderr || sourceStatus.stdout);
    const userChanges = sourceStatus.stdout.split(/\r?\n/).filter((line) => line.trim()).filter((line) => {
      const path = normalizeRepoPath(line.slice(3).split(' -> ').at(-1) ?? '');
      return path !== '.ai-harness' && !path.startsWith('.ai-harness/') && path !== '.dispatcher' && !path.startsWith('.dispatcher/');
    });
    if (userChanges.length > 0) {
      throw gitError('DIRTY_WORKING_TREE', 'The project working tree is dirty. Commit or stash user changes before starting an isolated Harness task.');
    }
    const baseRef = await this.resolveBaseRef(configuredBase);
    // Git refs cannot simultaneously contain `ai/TASK-001` and
    // `ai/TASK-001/T1` because one ref cannot also be a directory prefix.
    const integrationBranch = `ai/${taskId}/integration`;
    const integrationPath = this.safePath(taskId, 'integration');
    mkdirSync(resolve(integrationPath, '..'), { recursive: true });
    const reused = await this.reuseRegisteredWorktree(integrationPath, integrationBranch);
    if (reused) return { taskId, integrationBranch, integrationPath, baseRef };
    if (existsSync(integrationPath)) throw gitError('WORKTREE_CREATE_FAILED', `Unregistered path already exists: ${integrationPath}`);
    const branchExists = (await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${integrationBranch}`], this.projectRoot)).exitCode === 0;
    const args = branchExists
      ? ['worktree', 'add', integrationPath, integrationBranch]
      : ['worktree', 'add', '-b', integrationBranch, integrationPath, baseRef];
    const result = await this.git(args, this.projectRoot, 60_000);
    if (result.exitCode !== 0) throw gitError('WORKTREE_CREATE_FAILED', result.stderr || result.stdout);
    return { taskId, integrationBranch, integrationPath, baseRef };
  }

  async createSubtaskWorktree(task: TaskWorktrees, subtaskId: string): Promise<SubtaskWorktree> {
    const branch = `ai/${task.taskId}/${sanitizeSegment(subtaskId)}`;
    const path = this.safePath(task.taskId, sanitizeSegment(subtaskId));
    const reused = await this.reuseRegisteredWorktree(path, branch);
    if (reused) return { taskId: task.taskId, subtaskId, branch, path };
    if (existsSync(path)) throw gitError('WORKTREE_CREATE_FAILED', `Unregistered path already exists: ${path}`);
    const branchExists = (await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.projectRoot)).exitCode === 0;
    const args = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, task.integrationBranch];
    const result = await this.git(args, this.projectRoot, 60_000);
    if (result.exitCode !== 0) throw gitError('WORKTREE_CREATE_FAILED', result.stderr || result.stdout);
    return { taskId: task.taskId, subtaskId, branch, path };
  }

  async commitSubtask(worktree: SubtaskWorktree, message: string, expectedFiles: string[] = []): Promise<string | undefined> {
    const status = await this.git(['status', '--porcelain'], worktree.path);
    if (!status.stdout.trim()) return undefined;
    await this.requireSuccess(['add', '--all'], worktree.path);
    await this.assertSafeStagedChanges(worktree.path, expectedFiles);
    await this.requireSuccess(['commit', '-m', message], worktree.path, 60_000);
    const revision = await this.requireSuccess(['rev-parse', 'HEAD'], worktree.path);
    return revision.stdout.trim();
  }

  async assertSafeIntegrationChanges(task: TaskWorktrees, expectedFiles: string[] = []): Promise<void> {
    await this.requireSuccess(['add', '--all'], task.integrationPath);
    await this.assertSafeDiff(
      task.integrationPath,
      ['diff', '--name-status', '-z', `${task.baseRef}...HEAD`],
      ['diff', '--unified=0', '--no-ext-diff', `${task.baseRef}...HEAD`],
      expectedFiles,
    );
    await this.assertSafeStagedChanges(task.integrationPath, expectedFiles);
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

  private async reuseRegisteredWorktree(path: string, branch: string): Promise<boolean> {
    const listed = await this.requireSuccess(['worktree', 'list', '--porcelain'], this.projectRoot);
    const normalizedTarget = normalizePath(path);
    for (const entry of listed.stdout.split(/\r?\n\r?\n/)) {
      const lines = entry.split(/\r?\n/);
      const registeredPath = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      if (!registeredPath || normalizePath(registeredPath) !== normalizedTarget) continue;
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const registeredBranch = branchLine?.replace(/^branch refs\/heads\//, '');
      if (registeredBranch !== branch) {
        throw gitError('WORKTREE_CREATE_FAILED', `Worktree ${path} is registered to ${registeredBranch ?? 'detached HEAD'}, expected ${branch}.`);
      }
      return true;
    }
    return false;
  }

  private async assertSafeStagedChanges(cwd: string, expectedFiles: string[]): Promise<void> {
    await this.assertSafeDiff(
      cwd,
      ['diff', '--cached', '--name-status', '-z'],
      ['diff', '--cached', '--unified=0', '--no-ext-diff'],
      expectedFiles,
    );
  }

  private async assertSafeDiff(cwd: string, namesArgs: string[], diffArgs: string[], expectedFiles: string[]): Promise<void> {
    const names = await this.requireSuccess(namesArgs, cwd);
    const changed = parseNameStatus(names.stdout);
    const deletedTests = changed.filter((entry) => entry.status.startsWith('D') && isTestFile(entry.path));
    if (deletedTests.length > 0) {
      throw gitError('SAFETY_POLICY_VIOLATION', `Deleting tests is prohibited: ${deletedTests.map((entry) => entry.path).join(', ')}`);
    }
    if (expectedFiles.length > 0) {
      const expected = expectedFiles.map(normalizeRepoPath);
      const unrelated = changed.filter((entry) => !expected.some((file) => ownsPath(file, entry.path)));
      if (unrelated.length > 0) {
        throw gitError('SAFETY_POLICY_VIOLATION', `Changes outside the declared DAG file scope: ${unrelated.map((entry) => entry.path).join(', ')}`);
      }
    }
    const diff = await this.requireSuccess(diffArgs, cwd, 60_000);
    const disabledTest = diff.stdout.split(/\r?\n/).find((line) => /^\+(?!\+\+\+).*(?:\b(?:describe|it|test)\.(?:skip|todo)\s*\(|\b(?:xdescribe|xit|xtest)\s*\()/i.test(line));
    if (disabledTest) throw gitError('SAFETY_POLICY_VIOLATION', 'Disabling or skipping tests is prohibited.');
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

export function projectWorktreeRoot(projectRoot: string, configuredRoot: string): string {
  const namespace = createHash('sha256').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 12);
  return resolve(projectRoot, configuredRoot, `project-${namespace}`);
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const parts = output.split('\0').filter(Boolean);
  const result: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++]!;
    const path = parts[index++] ?? '';
    if (status.startsWith('R')) {
      const destination = parts[index++] ?? path;
      result.push(
        { status: 'D', path: normalizeRepoPath(path) },
        { status: 'A', path: normalizeRepoPath(destination) },
      );
    } else if (status.startsWith('C')) {
      const destination = parts[index++] ?? path;
      result.push({ status, path: normalizeRepoPath(destination) });
    } else {
      result.push({ status, path: normalizeRepoPath(path) });
    }
  }
  return result;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizePath(path: string): string {
  let normalized: string;
  try {
    normalized = realpathSync.native(path);
  } catch {
    normalized = resolve(path);
  }
  normalized = normalized.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isTestFile(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:spec|test)\.[^/]+$/i.test(path);
}

function ownsPath(expected: string, changed: string): boolean {
  if (expected.includes('*')) {
    const escaped = expected.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
    return new RegExp(`^${escaped}$`).test(changed);
  }
  const normalized = expected.replace(/\*\*?$/, '').replace(/\/$/, '');
  return changed === expected || (normalized.length > 0 && changed.startsWith(`${normalized}/`));
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '-');
  if (!sanitized) throw gitError('SAFETY_POLICY_VIOLATION', 'Invalid branch segment.');
  return sanitized;
}

function gitError(code: 'WORKTREE_CREATE_FAILED' | 'GIT_COMMAND_FAILED' | 'SAFETY_POLICY_VIOLATION' | 'DIRTY_WORKING_TREE', message: string) {
  return new DispatcherError({ code, message: message.trim(), retryable: code !== 'SAFETY_POLICY_VIOLATION' });
}
