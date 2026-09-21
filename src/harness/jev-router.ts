import { scrubSecrets } from '../logging/redaction.js';
import type { JevDecisionClient, JevDecisionResult, JevQuestion } from './jev-client.js';
import { BudgetManager, type AgentBudgetAllocation } from './budget-manager.js';

export type HarnessComplexity = 'trivial' | 'normal' | 'complex' | 'high' | 'critical';
export type HarnessRisk = 'low' | 'medium' | 'high' | 'critical';

export interface JevRouteInput {
  task: string;
  constraints?: string[];
  changedFileHints?: string[];
}

export interface JevRouteDecision extends AgentBudgetAllocation {
  complexity: HarnessComplexity;
  risk: HarnessRisk;
  source: 'jev' | 'deterministic-fallback';
  confidence?: number;
  model?: string;
  fallbackReason?: string;
}

export class JevRouter {
  constructor(
    private readonly client: JevDecisionClient,
    private readonly budget: BudgetManager,
  ) {}

  async route(input: JevRouteInput): Promise<JevRouteDecision> {
    if (!this.client.isConfigured()) {
      return this.withBudget(deterministicRoute(input), 'Jev API key is not configured.');
    }
    try {
      const result = await this.client.decide(compactState(input), routingQuestions());
      return this.withBudget(routeFromJev(result), undefined, result);
    } catch (cause) {
      return this.withBudget(
        deterministicRoute(input),
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  private withBudget(
    route: Omit<JevRouteDecision, keyof AgentBudgetAllocation | 'source' | 'fallbackReason' | 'confidence' | 'model'> & {
      codexWorkers: number;
      parallel: boolean;
      needArchitect: boolean;
      needReviewer: boolean;
      needSpecialist: boolean;
    },
    fallbackReason?: string,
    jevResult?: JevDecisionResult,
  ): JevRouteDecision {
    const allocation = this.budget.allocate(route);
    return {
      complexity: route.complexity,
      risk: route.risk,
      ...allocation,
      source: jevResult ? 'jev' : 'deterministic-fallback',
      confidence: jevResult ? minimumConfidence(jevResult) : undefined,
      model: jevResult?.model,
      fallbackReason,
    };
  }
}

function routeFromJev(result: JevDecisionResult): {
  complexity: HarnessComplexity;
  risk: HarnessRisk;
  codexWorkers: number;
  parallel: boolean;
  needArchitect: boolean;
  needReviewer: boolean;
  needSpecialist: boolean;
} {
  const complexity = choice(result, 'complexity', ['trivial', 'normal', 'complex', 'high', 'critical']) ?? 'normal';
  const risk = choice(result, 'risk', ['low', 'medium', 'high', 'critical']) ?? 'medium';
  const policy = defaultPolicy(complexity, risk, '');
  return {
    complexity,
    risk,
    codexWorkers: workers(choice(result, 'codex_workers', ['one', 'two', 'three'])),
    parallel: noul(result, 'parallel') ?? policy.parallel,
    needArchitect: noul(result, 'need_architect') ?? policy.needArchitect,
    needReviewer: noul(result, 'need_reviewer') ?? policy.needReviewer,
    needSpecialist: (noul(result, 'need_specialist') ?? policy.needSpecialist) && (risk === 'high' || risk === 'critical'),
  };
}

function deterministicRoute(input: JevRouteInput): {
  complexity: HarnessComplexity;
  risk: HarnessRisk;
  codexWorkers: number;
  parallel: boolean;
  needArchitect: boolean;
  needReviewer: boolean;
  needSpecialist: boolean;
} {
  const text = `${input.task} ${(input.changedFileHints ?? []).join(' ')}`.toLowerCase();
  const specialistDomain = /auth|authorization|authentication|payment|security|infra|terraform|migration|concurren|distributed|결제|인증|권한|보안|마이그레이션|동시성/.test(text);
  const destructive = /destructive|drop table|force push|production|삭제|파괴|운영 배포/.test(text);
  const repositoryWide = /repository|architecture|orchestrat|dashboard|worktree|전체|전면|아키텍처/.test(text);
  const tiny = input.task.length < 100 && !repositoryWide && !specialistDomain;
  const complexity: HarnessComplexity = destructive
    ? 'critical'
    : repositoryWide && input.task.length > 1_000
      ? 'high'
      : repositoryWide || input.task.length > 600
        ? 'complex'
        : tiny
          ? 'trivial'
          : 'normal';
  const risk: HarnessRisk = destructive ? 'critical' : specialistDomain ? 'high' : repositoryWide ? 'medium' : 'low';
  return defaultPolicy(complexity, risk, text);
}

function defaultPolicy(complexity: HarnessComplexity, risk: HarnessRisk, text: string) {
  const specialistDomain = /auth|authorization|authentication|payment|security|infra|terraform|migration|concurren|distributed|결제|인증|권한|보안|마이그레이션|동시성/.test(text);
  const needSpecialist = specialistDomain && (risk === 'high' || risk === 'critical');
  switch (complexity) {
    case 'trivial':
      return { complexity, risk, needArchitect: false, needReviewer: false, needSpecialist: false, codexWorkers: 1, parallel: false };
    case 'normal':
      return { complexity, risk, needArchitect: risk !== 'low', needReviewer: risk === 'high' || risk === 'critical', needSpecialist, codexWorkers: 1, parallel: false };
    case 'complex':
      return { complexity, risk, needArchitect: true, needReviewer: true, needSpecialist, codexWorkers: 2, parallel: true };
    case 'high':
      return { complexity, risk, needArchitect: true, needReviewer: true, needSpecialist, codexWorkers: 3, parallel: true };
    case 'critical':
      return { complexity, risk, needArchitect: true, needReviewer: true, needSpecialist, codexWorkers: 3, parallel: true };
  }
}

function compactState(input: JevRouteInput): Record<string, unknown> {
  return {
    task: scrubSecrets(input.task).slice(0, 8_000),
    constraints: (input.constraints ?? []).map(scrubSecrets).slice(0, 20),
    changed_file_hints: (input.changedFileHints ?? []).slice(0, 100),
    policy: 'Jev decides routing only. Claude designs and reviews. Codex implements. Budget limits are authoritative.',
  };
}

function routingQuestions(): Record<string, JevQuestion> {
  return {
    complexity: {
      type: 'choice',
      instructions: 'Classify implementation complexity.',
      criteria: {
        trivial: 'One small localized change.',
        normal: 'Ordinary implementation with limited scope.',
        complex: 'Multiple components or dependent tasks.',
        high: 'Repository-wide or high-coordination change.',
        critical: 'Safety-critical or architecture-wide change.',
      },
    },
    risk: {
      type: 'choice',
      instructions: 'Classify regression and operational risk.',
      criteria: { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
    },
    need_architect: { type: 'noul', instructions: 'Does this task require a separate Claude architect?' },
    need_reviewer: { type: 'noul', instructions: 'Does this task require a separate Claude reviewer?' },
    need_specialist: { type: 'noul', instructions: 'Does critical domain risk require a Claude specialist?' },
    codex_workers: {
      type: 'choice',
      instructions: 'Choose the useful Codex worker count, never more than three.',
      criteria: { one: 'One worker', two: 'Two workers', three: 'Three workers' },
    },
    parallel: { type: 'noul', instructions: 'Can independent implementation tasks safely run in parallel worktrees?' },
  };
}

function choice<T extends string>(result: JevDecisionResult, key: string, allowed: readonly T[]): T | undefined {
  const value = result.answers[key]?.choice;
  return value && allowed.includes(value as T) ? (value as T) : undefined;
}

function noul(result: JevDecisionResult, key: string): boolean | undefined {
  const value = result.answers[key]?.noul;
  return value === undefined ? undefined : value >= 0.5;
}

function workers(value: 'one' | 'two' | 'three' | undefined): number {
  return value === 'three' ? 3 : value === 'two' ? 2 : 1;
}

function minimumConfidence(result: JevDecisionResult): number | undefined {
  const values = Object.values(result.answers).flatMap((answer) => answer.confidence === undefined ? [] : [answer.confidence]);
  return values.length > 0 ? Math.min(...values) : undefined;
}
