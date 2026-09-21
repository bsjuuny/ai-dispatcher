import { describe, expect, it } from 'vitest';
import { BudgetManager } from '../../src/harness/budget-manager.js';
import { parseHarnessConfig } from '../../src/harness/config.js';

describe('BudgetManager', () => {
  it('always overrides an oversized Jev worker request', () => {
    const config = parseHarnessConfig({ budget: { task: { max_parallel_agents: 2 }, codex: { max_workers: 3 } } });
    const allocation = new BudgetManager(config.budget).allocate({
      codexWorkers: 5,
      parallel: true,
      needArchitect: true,
      needReviewer: true,
      needSpecialist: false,
    });

    expect(allocation.requestedCodexWorkers).toBe(5);
    expect(allocation.codexWorkers).toBe(2);
    expect(allocation.limited).toBe(true);
  });

  it('disables specialist calls when policy does not permit them', () => {
    const config = parseHarnessConfig({ budget: { specialist: { enabled: false } } });
    const allocation = new BudgetManager(config.budget).allocate({
      codexWorkers: 1,
      parallel: false,
      needArchitect: true,
      needReviewer: true,
      needSpecialist: true,
    });
    expect(allocation.needSpecialist).toBe(false);
    expect(allocation.reasons).toContain('Claude specialist disabled by budget policy.');
  });
});
