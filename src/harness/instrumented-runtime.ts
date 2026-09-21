import { DispatcherError, isDispatcherError } from '../models/error.js';
import { createHash } from 'node:crypto';
import type { AgentRuntime, HarnessAgentRequest, HarnessAgentResult } from './agent-runtime.js';
import type { HarnessConfig } from './config.js';
import type { TelemetryManager } from './telemetry.js';
import type { HarnessTaskLog } from './task-log.js';

export class InstrumentedAgentRuntime implements AgentRuntime {
  constructor(
    private readonly taskId: string,
    private readonly inner: AgentRuntime,
    private readonly telemetry: TelemetryManager,
    private readonly budget: HarnessConfig['budget'],
    private readonly log?: HarnessTaskLog,
    private readonly deadlineMs?: number,
    private readonly projectRoot = '',
  ) {}

  async run(request: HarnessAgentRequest): Promise<HarnessAgentResult> {
    const provider = request.kind;
    const remainingMs = this.deadlineMs === undefined ? request.timeoutMs : this.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new DispatcherError({ code: 'TASK_TIMEOUT', message: 'Harness task duration budget exhausted.', retryable: false, taskId: this.taskId });
    }
    const handle = this.telemetry.startWithBudget(this.taskId, request.name, provider, this.budget);
    try {
      const result = await this.inner.run({
        ...request,
        name: runtimeAgentName(this.projectRoot, this.taskId, request.runtimeKey ?? request.name),
        timeoutMs: Math.min(request.timeoutMs, remainingMs),
      });
      this.telemetry.finish(handle, {
        status: result.state === 'blocked' ? 'blocked' : result.state === 'failed' ? 'failed' : 'success',
        source: 'UNAVAILABLE',
        billingMode: 'UNKNOWN',
      });
      this.log?.appendAgent(this.taskId, request.name, { status: result.state, provider });
      return { ...result, name: request.name };
    } catch (cause) {
      this.telemetry.finish(handle, {
        status: isDispatcherError(cause) && cause.code === 'AGENT_BLOCKED' ? 'blocked' : isDispatcherError(cause) && cause.code === 'HERDR_TIMEOUT' ? 'timeout' : 'failed',
        source: 'UNAVAILABLE',
        billingMode: 'UNKNOWN',
      });
      this.log?.appendAgent(this.taskId, request.name, { status: 'failed', provider, errorCode: isDispatcherError(cause) ? cause.code : 'INTERNAL_LOGIC_ERROR' });
      throw cause;
    }
  }
}

export function runtimeAgentName(projectRoot: string, taskId: string, logicalName: string): string {
  const project = createHash('sha256').update(projectRoot.toLowerCase()).digest('hex').slice(0, 6);
  const task = taskId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 8);
  const logical = logicalName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 7);
  const suffix = createHash('sha256').update(logicalName).digest('hex').slice(0, 6);
  return `h${project}-${task}-${logical}-${suffix}`.slice(0, 32).replace(/-+$/g, '');
}
