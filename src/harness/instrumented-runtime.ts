import { DispatcherError, isDispatcherError } from '../models/error.js';
import type { AgentRuntime, HarnessAgentRequest, HarnessAgentResult } from './agent-runtime.js';
import type { HarnessConfig } from './config.js';
import { checkCallBudget, type TelemetryManager } from './telemetry.js';
import type { HarnessTaskLog } from './task-log.js';

export class InstrumentedAgentRuntime implements AgentRuntime {
  constructor(
    private readonly taskId: string,
    private readonly inner: AgentRuntime,
    private readonly telemetry: TelemetryManager,
    private readonly budget: HarnessConfig['budget'],
    private readonly log?: HarnessTaskLog,
  ) {}

  async run(request: HarnessAgentRequest): Promise<HarnessAgentResult> {
    const provider = request.kind;
    const allowed = checkCallBudget(provider, this.telemetry.summary(this.taskId), this.budget);
    if (!allowed.allowed) {
      throw new DispatcherError({ code: 'BUDGET_EXCEEDED', message: allowed.reason ?? 'Agent budget exhausted.', retryable: false, taskId: this.taskId });
    }
    const handle = this.telemetry.start(this.taskId, request.name, provider);
    try {
      const result = await this.inner.run(request);
      this.telemetry.finish(handle, {
        status: result.state === 'blocked' ? 'blocked' : result.state === 'failed' ? 'failed' : 'success',
        source: 'UNAVAILABLE',
        billingMode: 'UNKNOWN',
      });
      this.log?.appendAgent(this.taskId, request.name, { status: result.state, provider });
      return result;
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
