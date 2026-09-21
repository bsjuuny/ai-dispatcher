import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/history/db.js';
import { HistoryRepository } from '../../src/history/repository.js';
import { HarnessTaskManager } from '../../src/harness/task-manager.js';
import { TelemetryManager, checkCallBudget } from '../../src/harness/telemetry.js';
import { parseHarnessConfig } from '../../src/harness/config.js';

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
});
