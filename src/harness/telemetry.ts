import { randomUUID } from 'node:crypto';
import { DispatcherError } from '../models/error.js';
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

export interface ActiveAgentCall {
  callId: string;
  taskId: string;
  agent: string;
  provider: AgentProvider;
  startedAt: string;
  leaseExpiresAt: string;
}

export interface AgentCallLimits {
  providerMax: number;
  agentMax?: number;
}

export interface AgentLastStatus {
  agent: string;
  status: AgentCallRecord['status'];
  finishedAt: string;
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

export interface AgentUsageWindow {
  calls: number;
  durationMs: number;
  claudeCalls: number;
  codexCalls: number;
  jevCalls: number;
  actualCost: number | null;
}

export interface HarnessTelemetryStore {
  recordAgentCall(record: AgentCallRecord): void;
  reserveAgentCall(call: ActiveAgentCall, limits: AgentCallLimits): boolean;
  completeAgentCall(record: AgentCallRecord): void;
  getActiveAgentCalls(taskId?: string, now?: string): ActiveAgentCall[];
  getAgentUsageSummary(taskId: string): AgentUsageSummary;
  getLatestAgentStatuses(): AgentLastStatus[];
  getAgentUsageSince(since: string): AgentUsageWindow;
}

export class TelemetryManager {
  constructor(
    private readonly store: HarnessTelemetryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(taskId: string, agent: string, provider: AgentProvider): AgentCallHandle {
    return this.reserve(taskId, agent, provider, { providerMax: Number.POSITIVE_INFINITY }, provider === 'jev' ? 10 : 65);
  }

  startWithBudget(
    taskId: string,
    agent: string,
    provider: AgentProvider,
    budget: HarnessConfig['budget'],
  ): AgentCallHandle {
    const providerMax = provider === 'codex'
      ? budget.codex.max_calls
      : provider === 'claude'
        ? budget.claude.max_calls
        : Number.POSITIVE_INFINITY;
    const agentMax = agent === 'claude-specialist' ? budget.specialist.max_calls : undefined;
    return this.reserve(taskId, agent, provider, { providerMax, agentMax }, budget.task.max_duration_minutes + 5);
  }

  active(taskId?: string): ActiveAgentCall[] {
    return this.store.getActiveAgentCalls(taskId, this.now().toISOString());
  }

  private reserve(
    taskId: string,
    agent: string,
    provider: AgentProvider,
    limits: AgentCallLimits,
    leaseMinutes: number,
  ): AgentCallHandle {
    const started = this.now();
    const handle = {
      callId: randomUUID(),
      taskId,
      agent,
      provider,
      startedAt: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + leaseMinutes * 60_000).toISOString(),
      startedMs: started.getTime(),
    };
    if (!this.store.reserveAgentCall(handle, limits)) {
      throw new DispatcherError({
        code: 'BUDGET_EXCEEDED',
        message: `${agent} call budget exhausted.`,
        retryable: false,
        taskId,
      });
    }
    return handle;
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
    this.store.completeAgentCall(record);
    return record;
  }

  summary(taskId: string): AgentUsageSummary {
    return this.store.getAgentUsageSummary(taskId);
  }

  latestStatuses(): AgentLastStatus[] {
    return this.store.getLatestAgentStatuses();
  }

  totalsSince(since: Date): AgentUsageWindow {
    return this.store.getAgentUsageSince(since.toISOString());
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
