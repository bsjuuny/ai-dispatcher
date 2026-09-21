import { describe, expect, it, vi } from 'vitest';
import { HerdrAgentRuntime } from '../../src/harness/agent-runtime.js';
import type { HerdrAdapter, HerdrAgentState } from '../../src/harness/herdr-adapter.js';

function runtime(state: HerdrAgentState): HerdrAgentRuntime {
  const herdr = {
    createWorkspace: vi.fn().mockResolvedValue({ workspaceId: 'w1', rootPaneId: 'p1', raw: {} }),
    startAgent: vi.fn().mockResolvedValue({ state: 'idle', raw: {} }),
    prompt: vi.fn().mockResolvedValue({ state, raw: {} }),
    readAgent: vi.fn().mockResolvedValue('output'),
  } as unknown as HerdrAdapter;
  return new HerdrAgentRuntime(herdr);
}

describe('HerdrAgentRuntime', () => {
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
