import { describe, expect, it } from 'vitest';
import { parseHarnessConfig } from '../../src/harness/config.js';

describe('HarnessConfig', () => {
  it('applies safe V4 defaults', () => {
    const config = parseHarnessConfig({});
    expect(config.budget.task.max_retries).toBe(2);
    expect(config.budget.task.max_parallel_agents).toBe(3);
    expect(config.budget.codex.max_workers).toBe(3);
    expect(config.herdr.session).toBe('ai-harness');
    expect(config.pull_request.auto_create).toBe(true);
    expect(config.pull_request.auto_merge).toBe(false);
  });

  it('caps configured worker pools at three', () => {
    expect(() => parseHarnessConfig({ budget: { codex: { max_workers: 4 } } })).toThrow();
  });

  it('accepts string and argv-array quality commands', () => {
    const config = parseHarnessConfig({ quality: { lint: 'pnpm lint', test: ['pnpm', 'test'] } });
    expect(config.quality.lint).toBe('pnpm lint');
    expect(config.quality.test).toEqual(['pnpm', 'test']);
  });
});
