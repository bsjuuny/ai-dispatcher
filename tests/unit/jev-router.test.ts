import { describe, expect, it, vi } from 'vitest';
import { BudgetManager } from '../../src/harness/budget-manager.js';
import type { JevDecisionClient, JevDecisionResult } from '../../src/harness/jev-client.js';
import { JevRouter } from '../../src/harness/jev-router.js';
import { parseHarnessConfig } from '../../src/harness/config.js';

function client(configured: boolean, result?: JevDecisionResult): JevDecisionClient {
  return {
    isConfigured: () => configured,
    decide: vi.fn().mockResolvedValue(result),
  };
}

describe('JevRouter', () => {
  it('uses deterministic routing when Jev credentials are unavailable and labels the fallback', async () => {
    const config = parseHarnessConfig({});
    const router = new JevRouter(client(false), new BudgetManager(config.budget));

    const route = await router.route({ task: 'Rename one local variable' });

    expect(route).toMatchObject({
      complexity: 'trivial',
      risk: 'low',
      codexWorkers: 1,
      needArchitect: false,
      needReviewer: false,
      source: 'deterministic-fallback',
    });
    expect(route.fallbackReason).toMatch(/key is not configured/);
  });

  it('routes architecture-wide work to architect, reviewer, and parallel Codex workers', async () => {
    const config = parseHarnessConfig({});
    const router = new JevRouter(client(false), new BudgetManager(config.budget));

    const route = await router.route({ task: `Refactor the entire repository architecture and dashboard. ${'x'.repeat(700)}` });

    expect(route.complexity).toBe('complex');
    expect(route.needArchitect).toBe(true);
    expect(route.needReviewer).toBe(true);
    expect(route.codexWorkers).toBe(2);
    expect(route.parallel).toBe(true);
  });

  it('uses typed Jev answers but lets budget clamp worker count', async () => {
    const config = parseHarnessConfig({ budget: { codex: { max_workers: 2 } } });
    const router = new JevRouter(
      client(true, {
        model: 'typesafe-ai/jev',
        answers: {
          complexity: { choice: 'high', confidence: 0.91 },
          risk: { choice: 'high', confidence: 0.88 },
          need_architect: { noul: 0.99 },
          need_reviewer: { noul: 0.99 },
          need_specialist: { noul: 0.9 },
          codex_workers: { choice: 'three', confidence: 0.95 },
          parallel: { noul: 0.92 },
        },
      }),
      new BudgetManager(config.budget),
    );

    const route = await router.route({ task: 'High-risk authentication concurrency change' });

    expect(route).toMatchObject({
      source: 'jev',
      complexity: 'high',
      risk: 'high',
      requestedCodexWorkers: 3,
      codexWorkers: 2,
      limited: true,
      needSpecialist: true,
      confidence: 0.88,
      model: 'typesafe-ai/jev',
    });
  });

  it('falls back deterministically when the Jev request fails', async () => {
    const config = parseHarnessConfig({});
    const failing: JevDecisionClient = {
      isConfigured: () => true,
      decide: vi.fn().mockRejectedValue(new Error('service unavailable')),
    };
    const route = await new JevRouter(failing, new BudgetManager(config.budget)).route({
      task: 'Fix a normal form validation bug',
    });

    expect(route.source).toBe('deterministic-fallback');
    expect(route.fallbackReason).toBe('service unavailable');
  });

  it('enables a specialist only for high-risk specialist domains', async () => {
    const config = parseHarnessConfig({});
    const router = new JevRouter(client(false), new BudgetManager(config.budget));

    const route = await router.route({ task: 'Fix payment authorization concurrency bug' });
    expect(route.risk).toBe('high');
    expect(route.needSpecialist).toBe(true);
  });
});
