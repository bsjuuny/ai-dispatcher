import type {
  CreateHarnessTaskInput,
  HarnessPhaseEvent,
  HarnessTaskPatch,
  HarnessTaskQuery,
  HarnessTaskRecord,
} from './types.js';

/** Persistent workflow state boundary. SQLite is the default implementation,
 * but orchestration code depends only on this interface. */
export interface HarnessStateStore {
  create(input: CreateHarnessTaskInput): HarnessTaskRecord;
  get(taskId: string): HarnessTaskRecord | undefined;
  list(query?: HarnessTaskQuery): HarnessTaskRecord[];
  update(taskId: string, patch: HarnessTaskPatch, event?: HarnessPhaseEvent): HarnessTaskRecord;
  delete(taskId: string): boolean;
}
