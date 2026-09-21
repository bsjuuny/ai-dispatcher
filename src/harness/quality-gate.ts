import { DispatcherError } from '../models/error.js';
import { scrubSecrets } from '../logging/redaction.js';
import { runProcess } from '../process/process-runner.js';
import type { ProcessExecutor } from './herdr-adapter.js';

export const QUALITY_STAGES = ['lint', 'typecheck', 'test', 'integration', 'build', 'security'] as const;
export type QualityStage = (typeof QUALITY_STAGES)[number];
export type QualityCommand = string | string[];

export interface QualityStageResult {
  stage: QualityStage;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'TIMEOUT';
  command?: string[];
  exitCode?: number | null;
  durationMs: number;
  outputExcerpt?: string;
}

export interface QualityGateResult {
  passed: boolean;
  stages: QualityStageResult[];
  failedStages: QualityStage[];
  durationMs: number;
  errorCode?: 'QUALITY_COMMAND_MISSING';
}

export class DeterministicQualityGate {
  constructor(private readonly execute: ProcessExecutor = runProcess) {}

  async run(input: {
    cwd: string;
    commands: Partial<Record<QualityStage, QualityCommand>>;
    timeoutMs: number;
  }): Promise<QualityGateResult> {
    const startedAt = Date.now();
    const stages: QualityStageResult[] = [];
    for (const stage of QUALITY_STAGES) {
      const configured = input.commands[stage];
      if (!configured) {
        stages.push({ stage, status: 'SKIPPED', durationMs: 0 });
        continue;
      }
      const command = normalizeCommand(configured);
      const [file, ...args] = command;
      if (!file) throw invalidCommand(stage);
      const result = await this.execute({ file, args, cwd: input.cwd, timeoutMs: input.timeoutMs });
      const output = scrubSecrets(`${result.stdout}\n${result.stderr}`.trim());
      const status = result.timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'PASS' : 'FAIL';
      stages.push({
        stage,
        status,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputExcerpt: status === 'PASS' ? undefined : excerpt(output),
      });
    }
    const configuredCount = stages.filter((stage) => stage.status !== 'SKIPPED').length;
    const failedStages = stages.filter((stage) => stage.status === 'FAIL' || stage.status === 'TIMEOUT').map((stage) => stage.stage);
    return {
      passed: configuredCount > 0 && failedStages.length === 0,
      stages,
      failedStages,
      durationMs: Date.now() - startedAt,
      errorCode: configuredCount === 0 ? 'QUALITY_COMMAND_MISSING' : undefined,
    };
  }
}

export function normalizeCommand(command: QualityCommand): string[] {
  if (Array.isArray(command)) {
    if (command.length === 0 || command.some((part) => !part.trim())) throw invalidCommand('quality');
    return [...command];
  }
  if (/[;&|<>]/.test(command)) {
    throw new DispatcherError({
      code: 'QUALITY_COMMAND_INVALID',
      message: 'Quality commands must be one executable plus argv; shell operators are not allowed.',
      retryable: false,
    });
  }
  const parts: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(matcher)) parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  if (parts.length === 0) throw invalidCommand('quality');
  return parts;
}

function invalidCommand(stage: string): DispatcherError {
  return new DispatcherError({
    code: 'QUALITY_COMMAND_INVALID',
    message: `Invalid ${stage} quality command.`,
    retryable: false,
  });
}

function excerpt(output: string): string {
  const max = 4_000;
  if (output.length <= max) return output;
  return `${output.slice(0, max / 2)}\n...[truncated]...\n${output.slice(-max / 2)}`;
}
