import { resolve } from 'node:path';
import { defaultHarnessStateDbPath, openDatabase } from '../history/db.js';
import { HistoryRepository } from '../history/repository.js';
import { loadHarnessConfig } from './config.js';
import { HarnessTaskManager } from './task-manager.js';
import { HttpJevDecisionClient } from './jev-client.js';
import { JevRouter } from './jev-router.js';
import { BudgetManager } from './budget-manager.js';
import { TelemetryManager } from './telemetry.js';
import { HerdrAdapter } from './herdr-adapter.js';
import { HerdrAgentRuntime } from './agent-runtime.js';
import { ArtifactStore } from './artifact-store.js';
import { HarnessGitManager } from './git-manager.js';
import { DeterministicQualityGate } from './quality-gate.js';
import { JevFinalGate } from './final-gate.js';
import { GitHubManager } from './github-manager.js';
import { HarnessWorkflow } from './workflow.js';
import { HarnessTaskLog } from './task-log.js';

export function createHarnessContext(projectRoot: string): {
  projectRoot: string;
  state: HistoryRepository;
  tasks: HarnessTaskManager;
  config: ReturnType<typeof loadHarnessConfig>;
  jev: JevRouter;
  telemetry: TelemetryManager;
  workflow: HarnessWorkflow;
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
  const herdr = new HerdrAdapter({
    executable: config.herdr.executable,
    session: config.herdr.session,
    commandTimeoutMs: config.herdr.command_timeout_ms,
    agentStartupTimeoutMs: config.herdr.agent_startup_timeout_ms,
  });
  const workflow = new HarnessWorkflow({
    projectRoot: root,
    config,
    tasks,
    telemetry,
    jev,
    finalGate: new JevFinalGate(jevClient),
    runtime: new HerdrAgentRuntime(herdr),
    quality: new DeterministicQualityGate(),
    artifacts: new ArtifactStore(root),
    git: new HarnessGitManager(root, resolve(root, config.git.worktree_directory)),
    githubFactory: (integrationPath) => new GitHubManager(integrationPath),
    log: new HarnessTaskLog(root),
  });
  return { projectRoot: root, state, tasks, config, jev, telemetry, workflow };
}
