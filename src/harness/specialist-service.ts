import { scrubSecrets } from '../logging/redaction.js';
import type { AgentRuntime } from './agent-runtime.js';

export class ClaudeSpecialistService {
  constructor(private readonly runtime: AgentRuntime) {}

  async analyze(input: { requirement: string; domain: string; evidence: string[]; workingDirectory: string; timeoutMs: number }) {
    return this.runtime.run({
      name: 'claude-specialist',
      kind: 'claude',
      workingDirectory: input.workingDirectory,
      timeoutMs: input.timeoutMs,
      prompt: [
        `You are the Claude Specialist for ${input.domain}. Do not modify files.`,
        'Return a concise risk analysis and remediation plan for the Architect and Codex workers.',
        `Requirement: ${scrubSecrets(input.requirement).slice(0, 8_000)}`,
        `Evidence: ${JSON.stringify(input.evidence.map(scrubSecrets).slice(0, 100))}`,
      ].join('\n'),
    });
  }
}
