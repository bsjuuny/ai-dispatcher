import { describe, expect, it, vi } from 'vitest';
import { DeterministicQualityGate, normalizeCommand, type QualityCommand } from '../../src/harness/quality-gate.js';
import type { ProcessExecutor } from '../../src/harness/herdr-adapter.js';

describe('DeterministicQualityGate', () => {
  it('uses only process exit codes for PASS and FAIL', async () => {
    const execute = vi.fn<ProcessExecutor>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'lint says scary warning', stderr: '', timedOut: false, durationMs: 2 })
      .mockResolvedValueOnce({ exitCode: 1, stdout: 'tests claimed success', stderr: 'failure', timedOut: false, durationMs: 3 });
    const result = await new DeterministicQualityGate(execute).run({
      cwd: 'C:/repo',
      commands: { lint: ['pnpm', 'lint'], test: ['pnpm', 'test'] },
      timeoutMs: 1000,
    });
    expect(result.passed).toBe(false);
    expect(result.stages.find((stage) => stage.stage === 'lint')?.status).toBe('PASS');
    expect(result.stages.find((stage) => stage.stage === 'test')?.status).toBe('FAIL');
    expect(result.failedStages).toEqual(['test']);
  });

  it('fails closed when no quality commands are configured', async () => {
    const result = await new DeterministicQualityGate().run({ cwd: 'C:/repo', commands: {}, timeoutMs: 1000 });
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe('QUALITY_COMMAND_MISSING');
  });

  it('records a timeout independently from a nonzero exit', async () => {
    const execute = vi.fn<ProcessExecutor>().mockResolvedValue({
      exitCode: null,
      stdout: '',
      stderr: 'timed out',
      timedOut: true,
      durationMs: 1000,
    });
    const result = await new DeterministicQualityGate(execute).run({ cwd: 'C:/repo', commands: { build: ['pnpm', 'build'] }, timeoutMs: 1000 });
    expect(result.stages.find((stage) => stage.stage === 'build')?.status).toBe('TIMEOUT');
  });

  it('redacts secrets from failure excerpts', async () => {
    const execute = vi.fn<ProcessExecutor>().mockResolvedValue({
      exitCode: 1,
      stdout: 'Authorization: Bearer super-secret-value',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    });
    const result = await new DeterministicQualityGate(execute).run({ cwd: 'C:/repo', commands: { security: ['scan'] }, timeoutMs: 1000 });
    expect(result.stages.find((stage) => stage.stage === 'security')?.outputExcerpt).toContain('[REDACTED]');
  });
});

describe('normalizeCommand', () => {
  it.each<[QualityCommand, string[]]>([
    ['pnpm run lint', ['pnpm', 'run', 'lint']],
    ['node -e "process.exit(0)"', ['node', '-e', 'process.exit(0)']],
    [['gradlew.bat', 'test'], ['gradlew.bat', 'test']],
  ])('normalizes %j', (input, expected) => expect(normalizeCommand(input)).toEqual(expected));

  it('rejects shell chaining', () => {
    expect(() => normalizeCommand('npm test && deploy')).toThrow(/shell operators/);
  });
});
