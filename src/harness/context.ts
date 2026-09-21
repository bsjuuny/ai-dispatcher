import { resolve } from 'node:path';
import { defaultHarnessStateDbPath, openDatabase } from '../history/db.js';
import { HistoryRepository } from '../history/repository.js';
import { loadHarnessConfig } from './config.js';
import { HarnessTaskManager } from './task-manager.js';

export function createHarnessContext(projectRoot: string): {
  projectRoot: string;
  state: HistoryRepository;
  tasks: HarnessTaskManager;
  config: ReturnType<typeof loadHarnessConfig>;
} {
  const root = resolve(projectRoot);
  const config = loadHarnessConfig(root);
  const state = new HistoryRepository(openDatabase(defaultHarnessStateDbPath(root)));
  const tasks = new HarnessTaskManager(state, config.budget.task.max_retries);
  return { projectRoot: root, state, tasks, config };
}
