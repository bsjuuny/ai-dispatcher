import { randomUUID } from 'node:crypto';
import type { HarnessConfig } from './config.js';

export type UsageSource = 'ACTUAL' | 'ESTIMATED' | 'UNAVAILABLE';
export type BillingMode = 'SUBSCRIPTION' | 'API' | 'UNKNOWN';
export type AgentProvider = 'claude' | 'codex' | 'jev';

export interface AgentCallRecord {
  callId: string;
  taskId: string;
  agent: string;
  provider: AgentProvider;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'success' | 'failed' | 'blocked' | 'timeout';
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  actualCost?: number;
  source: UsageSource;
  billingMode: BillingMode;
}

export interface AgentUsageSummary {
  taskId: string;
  totalCalls: number;
  totalDurationMs: number;
  claudeCalls: number;
  codexCalls: number;
  jevCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  actualCost: number | null;
}

export interface HarnessTelemetryStore {
  recordAgentCall(record: AgentCallRecord): void;
  getAgentUsageSummary(taskId: string): AgentUsageSummary;
}

export class TelemetryManager {
  constructor(
    private readonly store: HarnessTelemetryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(taskId: string, agent: string, provider: AgentProvider): AgentCallHandle {
    const started = this.now();
    return { callId: randomUUID(), taskId, agent, provider, startedAt: started.toISOString(), startedMs: started.getTime() };
  }

  finish(
    handle: AgentCallHandle,
    input: Omit<AgentCallRecord, 'callId' | 'taskId' | 'agent' | 'provider' | 'startedAt' | 'finishedAt' | 'durationMs'>,
  ): AgentCallRecord {
    const finished = this.now();
    const record: AgentCallRecord = {
      callId: handle.callId,
      taskId: handle.taskId,
      agent: handle.agent,
      provider: handle.provider,
      startedAt: handle.startedAt,
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - handle.startedMs),
      ...input,
    };
    this.store.recordAgentCall(record);
    return record;
  }

  summary(taskId: string): AgentUsageSummary {
    return this.store.getAgentUsageSummary(taskId);
  }
}

export interface AgentCallHandle {
  callId: string;
  taskId: string;
  agent: string;
  provider: AgentProvider;
  startedAt: string;
  startedMs: number;
}

export function checkCallBudget(
  provider: AgentProvider,
  summary: AgentUsageSummary,
  budget: HarnessConfig['budget'],
): { allowed: boolean; reason?: string } {
  const used = provider === 'codex' ? summary.codexCalls : provider === 'jev' ? summary.jevCalls : summary.claudeCalls;
  const limit = provider === 'codex' ? budget.codex.max_calls : provider === 'claude' ? budget.claude.max_calls : Number.POSITIVE_INFINITY;
  return used < limit ? { allowed: true } : { allowed: false, reason: `${provider} call budget exhausted (${used}/${limit}).` };
}
