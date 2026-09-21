import { resolve } from 'node:path';
import { defaultHarnessStateDbPath, openDatabase } from '../history/db.js';
import { HistoryRepository } from '../history/repository.js';
import { loadHarnessConfig } from './config.js';
import { HarnessTaskManager } from './task-manager.js';
import { HttpJevDecisionClient } from './jev-client.js';
import { JevRouter } from './jev-router.js';
import { BudgetManager } from './budget-manager.js';
import { TelemetryManager } from './telemetry.js';

export function createHarnessContext(projectRoot: string): {
  projectRoot: string;
  state: HistoryRepository;
  tasks: HarnessTaskManager;
  config: ReturnType<typeof loadHarnessConfig>;
  jev: JevRouter;
  telemetry: TelemetryManager;
} {
  const root = resolve(projectRoot);
  const config = loadHarnessConfig(root);
  const state = new HistoryRepository(openDatabase(defaultHarnessStateDbPath(root)));
  const tasks = new HarnessTaskManager(state, config.budget.task.max_retries);
  const jevClient = new HttpJevDecisionClient({
    endpoint: config.jev.endpoint,
    apiKey: config.jev.enabled ? process.env[config.jev.api_key_env] : undefined,
    model: config.jev.model,
    timeoutMs: config.jev.timeout_ms,
  });
  const jev = new JevRouter(jevClient, new BudgetManager(config.budget));
  const telemetry = new TelemetryManager(state);
  return { projectRoot: root, state, tasks, config, jev, telemetry };
}
