import type { HarnessConfig } from './config.js';

export interface AgentBudgetRequest {
  codexWorkers: number;
  parallel: boolean;
  needArchitect: boolean;
  needReviewer: boolean;
  needSpecialist: boolean;
}

export interface AgentBudgetAllocation extends AgentBudgetRequest {
  requestedCodexWorkers: number;
  limited: boolean;
  reasons: string[];
}

export class BudgetManager {
  constructor(private readonly config: HarnessConfig['budget']) {}

  allocate(request: AgentBudgetRequest): AgentBudgetAllocation {
    const workerLimit = Math.min(
      3,
      this.config.task.max_parallel_agents,
      this.config.codex.max_workers,
    );
    const codexWorkers = Math.max(1, Math.min(Math.trunc(request.codexWorkers), workerLimit));
    const needSpecialist = request.needSpecialist && this.config.specialist.enabled && this.config.specialist.max_calls > 0;
    const reasons: string[] = [];
    if (codexWorkers !== request.codexWorkers) {
      reasons.push(`Codex workers limited from ${request.codexWorkers} to ${codexWorkers}.`);
    }
    if (request.needSpecialist && !needSpecialist) {
      reasons.push('Claude specialist disabled by budget policy.');
    }
    const parallel = request.parallel && codexWorkers > 1;
    return {
      ...request,
      requestedCodexWorkers: request.codexWorkers,
      codexWorkers,
      parallel,
      needSpecialist,
      limited: reasons.length > 0,
      reasons,
    };
  }
}
