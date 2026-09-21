import { describe, expect, it, vi } from 'vitest';
import { HerdrAgentRuntime } from '../../src/harness/agent-runtime.js';
import type { HerdrAdapter, HerdrAgentState } from '../../src/harness/herdr-adapter.js';

function runtime(state: HerdrAgentState): HerdrAgentRuntime {
  const herdr = {
    findAgent: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn().mockResolvedValue({ workspaceId: 'w1', rootPaneId: 'p1', raw: {} }),
    startAgent: vi.fn().mockResolvedValue({ state: 'idle', raw: {} }),
    prompt: vi.fn().mockResolvedValue({ state, raw: {} }),
    readAgent: vi.fn().mockResolvedValue('output'),
  } as unknown as HerdrAdapter;
  return new HerdrAgentRuntime(herdr);
}

describe('HerdrAgentRuntime', () => {
  it('reuses an existing settled agent instead of creating a duplicate workspace', async () => {
    const herdr = {
      findAgent: vi.fn().mockResolvedValue({ name: 'codex-1', paneId: 'w7:p3', state: 'idle', raw: {} }),
      createWorkspace: vi.fn(),
      startAgent: vi.fn(),
      prompt: vi.fn().mockResolvedValue({ state: 'done', raw: {} }),
      readAgent: vi.fn().mockResolvedValue('resumed'),
    } as unknown as HerdrAdapter;
    await expect(new HerdrAgentRuntime(herdr).run({
      name: 'codex-1', kind: 'codex', workingDirectory: 'C:/repo', prompt: 'continue', timeoutMs: 1000,
    })).resolves.toMatchObject({ workspaceId: 'w7', paneId: 'w7:p3', output: 'resumed' });
    expect(herdr.createWorkspace).not.toHaveBeenCalled();
  });

  it.each(['working', 'unknown'] as const)('fails closed when Herdr returns nonterminal state %s', async (state) => {
    await expect(runtime(state).run({
      name: 'codex-1', kind: 'codex', workingDirectory: 'C:/repo', prompt: 'task', timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 'AGENT_FAILED' });
  });

  it.each(['idle', 'done'] as const)('accepts settled completion state %s', async (state) => {
    await expect(runtime(state).run({
      name: 'codex-1', kind: 'codex', workingDirectory: 'C:/repo', prompt: 'task', timeoutMs: 1000,
    })).resolves.toMatchObject({ state, output: 'output' });
  });
});
