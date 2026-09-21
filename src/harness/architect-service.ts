import { scrubSecrets } from '../logging/redaction.js';
import type { AgentRuntime } from './agent-runtime.js';
import { parseArchitectPlan, type ArchitectPlan } from './plan.js';

export class ArchitectService {
  constructor(private readonly runtime: AgentRuntime) {}

  async plan(input: {
    requirement: string;
    workingDirectory: string;
    timeoutMs: number;
    repositoryContext?: string[];
  }): Promise<ArchitectPlan> {
    const requirement = scrubSecrets(input.requirement).slice(0, 8_000);
    const context = (input.repositoryContext ?? []).map(scrubSecrets).slice(0, 100);
    const result = await this.runtime.run({
      name: 'claude-architect',
      kind: 'claude',
      workingDirectory: input.workingDirectory,
      timeoutMs: input.timeoutMs,
      prompt: [
        'You are the Claude Architect. Do not modify files.',
        'Analyze the requirement and return only one JSON object.',
        'Schema: {"summary":string,"risks":string[],"testStrategy":string[],"tasks":[{"id":string,"title":string,"description":string,"dependencies":string[],"worker":"codex","files":string[],"risk":"low|medium|high|critical"}]}',
        'Tasks without dependencies may run in parallel. Avoid overlapping file ownership when possible.',
        `Requirement: ${requirement}`,
        `Repository context: ${JSON.stringify(context)}`,
      ].join('\n'),
    });
    return parseArchitectPlan(result.output);
  }
}
