import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, HarnessAgentRequest, HarnessAgentResult } from '../../src/harness/agent-runtime.js';
import { ArtifactStore } from '../../src/harness/artifact-store.js';
import { BudgetManager } from '../../src/harness/budget-manager.js';
import { parseHarnessConfig } from '../../src/harness/config.js';
import { JevFinalGate } from '../../src/harness/final-gate.js';
import { HarnessGitManager } from '../../src/harness/git-manager.js';
import { GitHubManager } from '../../src/harness/github-manager.js';
import type { JevDecisionClient } from '../../src/harness/jev-client.js';
import { JevRouter } from '../../src/harness/jev-router.js';
import { DeterministicQualityGate } from '../../src/harness/quality-gate.js';
import { HarnessTaskManager } from '../../src/harness/task-manager.js';
import { TelemetryManager } from '../../src/harness/telemetry.js';
import { HarnessWorkflow } from '../../src/harness/workflow.js';
import { HarnessTaskLog } from '../../src/harness/task-log.js';
import { openDatabase } from '../../src/history/db.js';
import { HistoryRepository } from '../../src/history/repository.js';
import type { ProcessOutcome } from '../../src/process/process-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class EditingRuntime implements AgentRuntime {
  async run(request: HarnessAgentRequest): Promise<HarnessAgentResult> {
    if (request.kind === 'codex') writeFileSync(join(request.workingDirectory, 'feature.txt'), 'implemented\n');
    return { name: request.name, state: 'done', output: 'ok', workspaceId: 'workspace', paneId: 'pane' };
  }
}

const unavailableJev: JevDecisionClient = {
  isConfigured: () => false,
  decide: async () => { throw new Error('not configured'); },
};

describe('HarnessWorkflow', () => {
  it('runs a trivial task through isolated implementation, quality, final gate, and commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-workflow-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const worktrees = join(root, 'worktrees');
    mkdirSync(repo);
    mkdirSync(worktrees);
    git(repo, ['init', '-b', 'master']);
    git(repo, ['config', 'user.email', 'harness@example.invalid']);
    git(repo, ['config', 'user.name', 'Harness Test']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', 'base.txt']);
    git(repo, ['commit', '-m', 'initial']);

    const config = parseHarnessConfig({
      git: { base_branch: 'master', worktree_directory: worktrees },
      pull_request: { auto_create: false, auto_merge: false },
      quality: { test: [process.execPath, '-e', 'process.exit(0)'] },
    });
    const state = new HistoryRepository(openDatabase(':memory:'));
    const tasks = new HarnessTaskManager(state, config.budget.task.max_retries);
    const telemetry = new TelemetryManager(state);
    const router = new JevRouter(unavailableJev, new BudgetManager(config.budget));
    let resumeChecks = false;
    const checkExecutor = vi.fn().mockImplementation(async (): Promise<ProcessOutcome> => ({
      exitCode: 0,
      stdout: JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }]),
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }));
    const workflow = new HarnessWorkflow({
      projectRoot: repo,
      config,
      tasks,
      telemetry,
      jev: router,
      finalGate: new JevFinalGate(unavailableJev),
      runtime: new EditingRuntime(),
      quality: new DeterministicQualityGate(),
      artifacts: new ArtifactStore(repo),
      git: new HarnessGitManager(repo, worktrees),
      githubFactory: (path) => new GitHubManager(path, resumeChecks ? checkExecutor : undefined),
      log: new HarnessTaskLog(repo),
    });

    const result = await workflow.start('Fix typo');
    expect(result.status).toBe('WAITING');
    expect(result.phase).toBe('WAITING_HUMAN');
    expect(result.metadata['maxParallelObserved']).toBe(1);
    expect(result.metadata['quality']).toMatchObject({ passed: true });
    expect(git(join(worktrees, result.id, 'integration'), ['branch', '--show-current'])).toBe(`ai/${result.id}/integration`);
    expect(git(join(worktrees, result.id, 'integration'), ['show', 'HEAD:feature.txt'])).toBe('implemented');
    expect(telemetry.summary(result.id)).toMatchObject({ codexCalls: 1, jevCalls: 1 });
    expect(readFileSync(join(repo, '.ai-harness', 'artifacts', result.id, 'plan.json'), 'utf8')).not.toContain('Fix typo');

    resumeChecks = true;
    tasks.recordMetadata(result.id, { delivery: { branch: `ai/${result.id}/integration`, integrationPath: join(worktrees, result.id, 'integration') } });
    tasks.fail(result.id, 'CI_CHECK_PENDING');
    const resumed = await workflow.resume(result.id);
    expect(resumed.phase).toBe('WAITING_HUMAN');
    expect(resumed.metadata['ci']).toEqual([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }]);
    expect(checkExecutor).toHaveBeenCalledOnce();
    state.close();
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
