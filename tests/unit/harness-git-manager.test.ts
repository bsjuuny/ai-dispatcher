import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessGitManager } from '../../src/harness/git-manager.js';
import type { ProcessExecutor } from '../../src/harness/herdr-adapter.js';

interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'harness-git-'));
  const repo = join(root, 'repo');
  const worktrees = join(root, 'worktrees');
  mkdirSync(repo);
  mkdirSync(worktrees);
  git(repo, ['init', '-b', 'master']);
  git(repo, ['config', 'user.email', 'harness@example.invalid']);
  git(repo, ['config', 'user.name', 'Harness Test']);
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  git(repo, ['add', 'app.txt']);
  git(repo, ['commit', '-m', 'initial']);
  const value = { root, repo, worktrees };
  fixtures.push(value);
  return value;
}

describe('HarnessGitManager', () => {
  it('creates isolated integration/subtask branches and merges a committed subtask', async () => {
    const test = fixture();
    const manager = new HarnessGitManager(test.repo, test.worktrees);
    const task = await manager.createTaskWorktree('TASK-001', 'main');
    const subtask = await manager.createSubtaskWorktree(task, 'T1');

    expect(task.baseRef).toBe('master');
    expect(task.integrationBranch).toBe('ai/TASK-001/integration');
    expect(subtask.branch).toBe('ai/TASK-001/T1');
    writeFileSync(join(subtask.path, 'feature.txt'), 'implemented\n');
    expect(await manager.commitSubtask(subtask, 'feat(T1): implement feature')).toMatch(/^[a-f0-9]{40}$/);
    expect((await manager.mergeSubtask(task, subtask)).status).toBe('MERGED');
    expect(await manager.diff(task)).toContain('implemented');

    await manager.removeWorktree(subtask.path);
    await manager.removeWorktree(task.integrationPath);
  });

  it('aborts an ambiguous merge conflict instead of resolving it automatically', async () => {
    const test = fixture();
    const manager = new HarnessGitManager(test.repo, test.worktrees);
    const task = await manager.createTaskWorktree('TASK-002', 'master');
    const first = await manager.createSubtaskWorktree(task, 'T1');
    const second = await manager.createSubtaskWorktree(task, 'T2');
    writeFileSync(join(first.path, 'app.txt'), 'first\n');
    writeFileSync(join(second.path, 'app.txt'), 'second\n');
    await manager.commitSubtask(first, 'feat(T1): first change');
    await manager.commitSubtask(second, 'feat(T2): second change');
    expect((await manager.mergeSubtask(task, first)).status).toBe('MERGED');
    expect((await manager.mergeSubtask(task, second)).status).toBe('CONFLICT');
    expect(git(task.integrationPath, ['status', '--porcelain'])).toBe('');

    await manager.removeWorktree(first.path);
    await manager.removeWorktree(second.path);
    await manager.removeWorktree(task.integrationPath);
  });

  it('rejects cleanup outside the configured worktree root', async () => {
    const test = fixture();
    await expect(new HarnessGitManager(test.repo, test.worktrees).removeWorktree(test.repo)).rejects.toMatchObject({
      code: 'SAFETY_POLICY_VIOLATION',
    });
  });

  it('serializes concurrent merges into the same integration worktree', async () => {
    let active = 0;
    let maxActive = 0;
    const execute: ProcessExecutor = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { exitCode: 0, stdout: 'merged', stderr: '', timedOut: false, durationMs: 10 };
    };
    const manager = new HarnessGitManager('C:/repo', 'C:/worktrees', execute);
    const task = { taskId: 'TASK-001', integrationBranch: 'ai/TASK-001/integration', integrationPath: 'C:/worktrees/TASK-001/integration', baseRef: 'main' };
    await Promise.all([
      manager.mergeSubtask(task, { taskId: task.taskId, subtaskId: 'T1', branch: 'ai/TASK-001/T1', path: 'C:/worktrees/TASK-001/T1' }),
      manager.mergeSubtask(task, { taskId: task.taskId, subtaskId: 'T2', branch: 'ai/TASK-001/T2', path: 'C:/worktrees/TASK-001/T2' }),
    ]);
    expect(maxActive).toBe(1);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
