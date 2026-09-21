import { z } from 'zod';
import { scrubSecrets } from '../logging/redaction.js';
import { DispatcherError } from '../models/error.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { QualityGateResult } from './quality-gate.js';

const ReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']),
  issues: z.array(z.object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    category: z.enum(['requirement', 'correctness', 'regression', 'security', 'concurrency', 'error-handling', 'maintainability', 'complexity', 'tests', 'unrelated']),
    message: z.string().min(1),
    file: z.string().optional(),
  })).default([]),
});

export type ClaudeReview = z.infer<typeof ReviewSchema>;

export class ClaudeReviewerService {
  constructor(private readonly runtime: AgentRuntime) {}

  async review(input: {
    requirement: string;
    diff: string;
    changedFiles: string[];
    quality: QualityGateResult;
    workingDirectory: string;
    timeoutMs: number;
  }): Promise<ClaudeReview> {
    const result = await this.runtime.run({
      name: 'claude-reviewer',
      kind: 'claude',
      workingDirectory: input.workingDirectory,
      timeoutMs: input.timeoutMs,
      prompt: [
        'You are the independent Claude Reviewer. Do not modify files.',
        'Return only JSON: {"verdict":"APPROVE|REVISE","issues":[{"severity":"low|medium|high|critical","category":"requirement|correctness|regression|security|concurrency|error-handling|maintainability|complexity|tests|unrelated","message":string,"file"?:string}]}',
        'Review requirement coverage, correctness, regression risk, security, concurrency, error handling, maintainability, unnecessary complexity, missing tests, and unrelated changes.',
        `Requirement: ${scrubSecrets(input.requirement).slice(0, 8_000)}`,
        `Changed files: ${JSON.stringify(input.changedFiles.slice(0, 200))}`,
        `Quality: ${JSON.stringify(input.quality)}`,
        `Diff: ${scrubSecrets(input.diff).slice(0, 24_000)}`,
      ].join('\n'),
    });
    return parseReview(result.output);
  }
}

export function parseReview(output: string): ClaudeReview {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  try {
    if (start < 0 || end <= start) throw new Error('No JSON object found.');
    const review = ReviewSchema.parse(JSON.parse(output.slice(start, end + 1)));
    if (review.verdict === 'REVISE' && review.issues.length === 0) throw new Error('REVISE requires actionable issues.');
    return review;
  } catch (cause) {
    throw new DispatcherError({
      code: 'AGENT_OUTPUT_INVALID',
      message: `Claude reviewer returned invalid output: ${(cause as Error).message}`,
      cause,
      retryable: true,
    });
  }
}
