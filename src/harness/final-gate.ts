import type { JevDecisionClient, JevQuestion } from './jev-client.js';
import type { QualityGateResult } from './quality-gate.js';
import type { ClaudeReview } from './review-service.js';

export type FinalGateDecision = 'PASS' | 'RETRY_CODEX' | 'ESCALATE_CLAUDE' | 'STOP';

export interface FinalGateResult {
  decision: FinalGateDecision;
  source: 'jev' | 'deterministic-fallback' | 'deterministic-precondition';
  reason: string;
  confidence?: number;
}

export class JevFinalGate {
  constructor(private readonly client: JevDecisionClient) {}

  async decide(input: {
    quality: QualityGateResult;
    review: ClaudeReview;
    retry: number;
    maxRetry: number;
  }): Promise<FinalGateResult> {
    const required = deterministicDecision(input);
    if (required.decision === 'STOP' || !input.quality.passed) return required;
    if (!this.client.isConfigured()) return required;
    try {
      const result = await this.client.decide(
        {
          quality_passed: input.quality.passed,
          quality_stages: input.quality.stages.map((stage) => ({ stage: stage.stage, status: stage.status, exit_code: stage.exitCode })),
          reviewer_verdict: input.review.verdict,
          reviewer_issues: input.review.issues.map((issue) => ({ severity: issue.severity, category: issue.category, message: issue.message.slice(0, 500) })),
          retry: input.retry,
          max_retry: input.maxRetry,
        },
        finalQuestions(),
      );
      const answer = result.answers['decision'];
      const selected = answer?.choice as FinalGateDecision | undefined;
      if (!selected || !['PASS', 'RETRY_CODEX', 'ESCALATE_CLAUDE', 'STOP'].includes(selected)) return required;
      if (selected === 'PASS' && input.review.verdict !== 'APPROVE') return required;
      return { decision: selected, source: 'jev', reason: 'Jev evaluated verified quality and independent review evidence.', confidence: answer?.confidence };
    } catch {
      return required;
    }
  }
}

function deterministicDecision(input: { quality: QualityGateResult; review: ClaudeReview; retry: number; maxRetry: number }): FinalGateResult {
  if (input.retry >= input.maxRetry && (!input.quality.passed || input.review.verdict === 'REVISE')) {
    return { decision: 'STOP', source: 'deterministic-precondition', reason: 'Maximum retries reached.' };
  }
  if (!input.quality.passed) {
    const securityFailed = input.quality.failedStages.includes('security');
    return {
      decision: securityFailed ? 'ESCALATE_CLAUDE' : 'RETRY_CODEX',
      source: 'deterministic-precondition',
      reason: `Quality failed: ${input.quality.failedStages.join(', ') || input.quality.errorCode}.`,
    };
  }
  if (input.review.verdict === 'REVISE') {
    const architectural = input.review.issues.some((issue) => ['requirement', 'security', 'concurrency'].includes(issue.category) || issue.severity === 'critical');
    return {
      decision: architectural ? 'ESCALATE_CLAUDE' : 'RETRY_CODEX',
      source: 'deterministic-fallback',
      reason: architectural ? 'Reviewer found architecture, requirement, or security issues.' : 'Reviewer found implementation issues.',
    };
  }
  return { decision: 'PASS', source: 'deterministic-fallback', reason: 'Quality passed and reviewer approved.' };
}

function finalQuestions(): Record<string, JevQuestion> {
  return {
    decision: {
      type: 'choice',
      instructions: 'Choose the final workflow action. Never infer test success; use supplied exit-code evidence.',
      criteria: {
        PASS: 'All verified evidence supports completion.',
        RETRY_CODEX: 'A concrete implementation issue remains.',
        ESCALATE_CLAUDE: 'Architecture, requirement, security, or design remediation is required.',
        STOP: 'Automation must stop for a human or exhausted budget.',
      },
    },
  };
}
