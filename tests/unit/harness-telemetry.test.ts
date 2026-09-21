import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/history/db.js';
import { HistoryRepository } from '../../src/history/repository.js';
import { HarnessTaskManager } from '../../src/harness/task-manager.js';
import { TelemetryManager, checkCallBudget } from '../../src/harness/telemetry.js';
import { parseHarnessConfig } from '../../src/harness/config.js';
import { InstrumentedAgentRuntime, runtimeAgentName } from '../../src/harness/instrumented-runtime.js';
import type { AgentRuntime } from '../../src/harness/agent-runtime.js';

describe('Harness telemetry', () => {
  let history: HistoryRepository;
  let telemetry: TelemetryManager;

  beforeEach(() => {
    history = new HistoryRepository(openDatabase(':memory:'));
    new HarnessTaskManager(history, 2).create('test task', 'C:/repo');
    const times = [new Date('2026-09-22T00:00:00.000Z'), new Date('2026-09-22T00:00:01.500Z')];
    telemetry = new TelemetryManager(history, () => times.shift() ?? new Date('2026-09-22T00:00:01.500Z'));
  });

  it('records actual provider usage without inventing absent token or cost values', () => {
    const handle = telemetry.start('TASK-001', 'claude-architect', 'claude');
    telemetry.finish(handle, {
      status: 'success',
      source: 'UNAVAILABLE',
      billingMode: 'SUBSCRIPTION',
    });
    const summary = telemetry.summary('TASK-001');
    expect(summary).toMatchObject({ totalCalls: 1, claudeCalls: 1, codexCalls: 0, totalDurationMs: 1500 });
    expect(summary.inputTokens).toBeNull();
    expect(summary.actualCost).toBeNull();
    expect(telemetry.latestStatuses()).toEqual([{ agent: 'claude-architect', status: 'success', finishedAt: '2026-09-22T00:00:01.500Z' }]);
    expect(telemetry.totalsSince(new Date('2026-09-21T00:00:00.000Z'))).toMatchObject({ calls: 1, claudeCalls: 1, actualCost: null });
  });

  it('sums actual token and cost data only when supplied', () => {
    const handle = telemetry.start('TASK-001', 'codex-1', 'codex');
    telemetry.finish(handle, {
      status: 'success',
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
      actualCost: 0.12,
      source: 'ACTUAL',
      billingMode: 'API',
    });
    expect(telemetry.summary('TASK-001')).toMatchObject({
      codexCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
      actualCost: 0.12,
    });
  });

  it('blocks new calls when a provider call budget is exhausted', () => {
    const budget = parseHarnessConfig({ budget: { claude: { max_calls: 1 } } }).budget;
    const handle = telemetry.start('TASK-001', 'claude-architect', 'claude');
    telemetry.finish(handle, { status: 'success', source: 'UNAVAILABLE', billingMode: 'SUBSCRIPTION' });
    expect(checkCallBudget('claude', telemetry.summary('TASK-001'), budget)).toMatchObject({ allowed: false });
  });

  it('reserves parallel call budget before an agent finishes', () => {
    const budget = parseHarnessConfig({ budget: { codex: { max_calls: 1 } } }).budget;
    telemetry.startWithBudget('TASK-001', 'codex-1', 'codex', budget);
    expect(() => telemetry.startWithBudget('TASK-001', 'codex-2', 'codex', budget)).toThrow(/budget exhausted/);
    expect(telemetry.active('TASK-001')).toHaveLength(1);
  });

  it('expires abandoned activity leases so a crashed process cannot block budget forever', () => {
    const times = [new Date('2026-09-22T00:00:00.000Z'), new Date('2026-09-22T02:00:00.000Z')];
    const leased = new TelemetryManager(history, () => times.shift() ?? new Date('2026-09-22T02:00:00.000Z'));
    leased.start('TASK-001', 'codex-1', 'codex');
    expect(leased.active('TASK-001')).toHaveLength(0);
  });

  it('creates project and task scoped Herdr-safe runtime names', () => {
    const first = runtimeAgentName('C:/repo-a', 'TASK-001', 'codex-1');
    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(first).not.toBe(runtimeAgentName('C:/repo-b', 'TASK-001', 'codex-1'));
  });

  it('enforces the separate specialist call limit', () => {
    const budget = parseHarnessConfig({ budget: { claude: { max_calls: 3 }, specialist: { enabled: true, max_calls: 1 } } }).budget;
    const handle = telemetry.startWithBudget('TASK-001', 'claude-specialist', 'claude', budget);
    telemetry.finish(handle, { status: 'success', source: 'UNAVAILABLE', billingMode: 'SUBSCRIPTION' });
    expect(() => telemetry.startWithBudget('TASK-001', 'claude-specialist', 'claude', budget)).toThrow(/budget exhausted/);
  });

  it('enforces the overall task duration before starting another agent', async () => {
    const inner: AgentRuntime = { run: async () => { throw new Error('must not run'); } };
    const budget = parseHarnessConfig({}).budget;
    const runtime = new InstrumentedAgentRuntime('TASK-001', inner, telemetry, budget, undefined, Date.now() - 1);
    await expect(runtime.run({
      name: 'codex-1', kind: 'codex', workingDirectory: 'C:/repo', prompt: 'task', timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 'TASK_TIMEOUT' });
    expect(telemetry.active('TASK-001')).toHaveLength(0);
  });
});
