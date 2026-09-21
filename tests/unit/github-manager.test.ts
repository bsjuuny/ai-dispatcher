import { describe, expect, it, vi } from 'vitest';
import type { ProcessOutcome } from '../../src/process/process-runner.js';
import { GitHubManager } from '../../src/harness/github-manager.js';

const ok = (stdout = ''): ProcessOutcome => ({ exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 });

describe('GitHubManager', () => {
  it('commits, pushes, creates a PR, and reads structured PR data', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(ok('ai/TASK-001/integration\n'))
      .mockResolvedValueOnce(ok(' M src/a.ts\n'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockResolvedValueOnce(ok('ai/TASK-001/integration\n'))
      .mockResolvedValueOnce(ok('pushed'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('https://github.test/pr/7'))
      .mockResolvedValueOnce(ok(JSON.stringify({ number: 7, url: 'https://github.test/pr/7', state: 'OPEN', headRefName: 'ai/TASK-001/integration', baseRefName: 'main', headRefOid: 'abc123' })));
    const manager = new GitHubManager('C:/repo', execute);

    expect(await manager.commitIntegration('TASK-001', 'Fix login')).toBe('abc123');
    expect(await manager.pushIntegration('TASK-001')).toBe('pushed');
    const pr = await manager.createPullRequest({
      taskId: 'TASK-001', branch: 'ai/TASK-001/integration', baseBranch: 'main', title: 'Fix login', body: 'Verified.',
    });
    expect(pr.number).toBe(7);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ file: 'git', args: ['push', '--set-upstream', 'origin', 'ai/TASK-001/integration'] }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ file: 'gh', args: expect.arrayContaining(['pr', 'create', 'feat: Fix login']) }));
  });

  it('blocks commits and pushes outside the task integration branch', async () => {
    const execute = vi.fn().mockResolvedValue(ok('main\n'));
    const manager = new GitHubManager('C:/repo', execute);
    await expect(manager.commitIntegration('TASK-001', 'Unsafe')).rejects.toMatchObject({ code: 'SAFETY_POLICY_VIOLATION' });
  });

  it('requires all CI checks to pass before an explicit merge', async () => {
    const execute = vi.fn().mockResolvedValueOnce(ok(JSON.stringify([
      { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/build' },
      { name: 'test', state: 'PENDING', bucket: 'pending', link: 'https://ci/test' },
    ])));
    const manager = new GitHubManager('C:/repo', execute);
    await expect(manager.mergeAfterHumanApproval('TASK-001', 'ai/TASK-001/integration', 'abc123')).rejects.toMatchObject({ code: 'CI_CHECK_PENDING' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('merges only after passing checks and detects protected auto-merge paths', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(ok(JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }])))
      .mockResolvedValueOnce(ok(JSON.stringify({ number: 7, url: 'https://github.test/pr/7', state: 'OPEN', headRefName: 'ai/TASK-001/integration', baseRefName: 'main', headRefOid: 'abc123' })))
      .mockResolvedValueOnce(ok('merged'));
    const manager = new GitHubManager('C:/repo', execute);
    await manager.mergeAfterHumanApproval('TASK-001', 'ai/TASK-001/integration', 'abc123', 'main');
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ file: 'gh', args: ['pr', 'merge', 'ai/TASK-001/integration', '--merge', '--match-head-commit', 'abc123'] }));
    expect(GitHubManager.permitsAutoMerge(['src/a.ts'], ['auth/**'])).toBe(true);
    expect(GitHubManager.permitsAutoMerge(['auth/session.ts'], ['auth/**'])).toBe(false);
  });

  it('parses pending checks from gh exit code 8 instead of treating them as a command failure', async () => {
    const execute = vi.fn().mockResolvedValue({ ...ok(JSON.stringify([
      { name: 'build', state: 'PENDING', bucket: 'pending' },
    ])), exitCode: 8 });
    const checks = await new GitHubManager('C:/repo', execute).requiredChecks('ai/TASK-001/integration');
    expect(checks).toEqual([{ name: 'build', state: 'PENDING', bucket: 'pending', link: undefined }]);
  });

  it('uses gh watch for bounded CI waiting and reports timeout as pending', async () => {
    const execute = vi.fn().mockResolvedValue({ ...ok(), exitCode: null, timedOut: true });
    await expect(new GitHubManager('C:/repo', execute).waitForRequiredChecks('ai/TASK-001/integration', 5000))
      .rejects.toMatchObject({ code: 'CI_CHECK_PENDING' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['pr', 'checks', '--watch', '--interval', '10']),
      timeoutMs: 5000,
    }));
  });

  it('treats an explicit no-required-checks response as an empty successful set', async () => {
    const execute = vi.fn().mockResolvedValue({
      ...ok(), exitCode: 1, stderr: "no required checks reported on the 'feature' branch",
    });
    await expect(new GitHubManager('C:/repo', execute).requiredChecks('ai/TASK-001/integration')).resolves.toEqual([]);
  });

  it('fails closed when the pull request head changed after review', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(ok(JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }])))
      .mockResolvedValueOnce(ok(JSON.stringify({ number: 7, url: 'https://github.test/pr/7', state: 'OPEN', headRefName: 'ai/TASK-001/integration', baseRefName: 'main', headRefOid: 'changed' })));
    await expect(new GitHubManager('C:/repo', execute).mergeAfterHumanApproval(
      'TASK-001', 'ai/TASK-001/integration', 'reviewed', 'main',
    )).rejects.toMatchObject({ code: 'SAFETY_POLICY_VIOLATION' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
