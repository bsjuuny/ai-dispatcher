import { describe, expect, it, vi } from 'vitest';
import { HerdrAdapter, type ProcessExecutor } from '../../src/harness/herdr-adapter.js';
import type { ProcessOutcome } from '../../src/process/process-runner.js';

function outcome(stdout: string, overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    durationMs: 10,
    ...overrides,
  };
}

function adapter(execute: ProcessExecutor): HerdrAdapter {
  return new HerdrAdapter(
    {
      executable: 'herdr',
      session: 'ai-harness',
      commandTimeoutMs: 30_000,
      agentStartupTimeoutMs: 30_000,
    },
    execute,
  );
}

describe('HerdrAdapter', () => {
  it('selects an isolated named session for control commands', async () => {
    const execute = vi.fn<ProcessExecutor>().mockResolvedValue(
      outcome(JSON.stringify({ result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } })),
    );

    const workspace = await adapter(execute).createWorkspace('C:/repo', 'task-1');

    expect(workspace).toMatchObject({ workspaceId: 'w1', rootPaneId: 'w1:p1' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'herdr',
        args: ['workspace', 'create', '--cwd', 'C:/repo', '--label', 'task-1', '--no-focus'],
        env: expect.objectContaining({ HERDR_SESSION: 'ai-harness' }),
      }),
    );
  });

  it('does not scope version and session discovery to a possibly unavailable session', async () => {
    const execute = vi.fn<ProcessExecutor>()
      .mockResolvedValueOnce(outcome('herdr 0.8.2\n'))
      .mockResolvedValueOnce(outcome(JSON.stringify({ sessions: [{ name: 'default', running: false, default: true }] })));
    const herdr = adapter(execute);

    expect(await herdr.version('C:/repo')).toBe('herdr 0.8.2');
    expect(await herdr.listSessions('C:/repo')).toEqual([{ name: 'default', running: false, default: true }]);
    expect(execute.mock.calls[0]![0].env?.['HERDR_SESSION']).toBeUndefined();
    expect(execute.mock.calls[1]![0].env?.['HERDR_SESSION']).toBeUndefined();
  });

  it('starts a named agent in an explicit pane and preserves native resume args', async () => {
    const execute = vi.fn<ProcessExecutor>().mockResolvedValue(
      outcome(JSON.stringify({ result: { agent: { name: 'claude-architect', pane_id: 'w1:p1', state: 'idle' } } })),
    );

    const snapshot = await adapter(execute).startAgent('C:/repo', {
      name: 'claude-architect',
      kind: 'claude',
      paneId: 'w1:p1',
      nativeArgs: ['--resume', 'session-id'],
    });

    expect(snapshot).toMatchObject({ name: 'claude-architect', paneId: 'w1:p1', state: 'idle' });
    expect(execute.mock.calls[0]![0].args).toEqual([
      'agent', 'start', 'claude-architect', '--kind', 'claude', '--pane', 'w1:p1',
      '--timeout', '30000', '--', '--resume', 'session-id',
    ]);
  });

  it('uses lifecycle-aware prompt wait and returns blocked without auto-approval', async () => {
    const execute = vi.fn<ProcessExecutor>().mockResolvedValue(
      outcome(JSON.stringify({ result: { agent: { name: 'codex-1', pane_id: 'w1:p2', state: 'blocked' } } })),
    );

    const snapshot = await adapter(execute).prompt('C:/repo', 'codex-1', 'Implement T1', 120_000);

    expect(snapshot.state).toBe('blocked');
    expect(execute.mock.calls[0]![0].args).toEqual([
      'agent', 'prompt', 'codex-1', 'Implement T1', '--wait', '--timeout', '120000',
    ]);
  });

  it('rejects oversized argv prompts so callers must pass a compact artifact reference', async () => {
    const execute = vi.fn<ProcessExecutor>();
    await expect(adapter(execute).prompt('C:/repo', 'codex-1', 'x'.repeat(17 * 1024), 10_000)).rejects.toMatchObject({
      code: 'HERDR_PROMPT_TOO_LARGE',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps CLI timeout and command errors to explicit harness errors', async () => {
    const timeout = adapter(vi.fn<ProcessExecutor>().mockResolvedValue(outcome('', { timedOut: true })));
    await expect(timeout.getAgent('C:/repo', 'codex-1')).rejects.toMatchObject({ code: 'HERDR_TIMEOUT' });

    const failed = adapter(
      vi.fn<ProcessExecutor>().mockResolvedValue(outcome('', { exitCode: 1, stderr: 'agent_pane_busy' })),
    );
    await expect(failed.getAgent('C:/repo', 'codex-1')).rejects.toMatchObject({
      code: 'HERDR_COMMAND_FAILED',
      retryable: true,
    });
  });
});
