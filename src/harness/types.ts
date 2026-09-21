export const HARNESS_PHASES = [
  'CREATED',
  'ROUTING',
  'PLANNING',
  'DAG_CREATED',
  'CODEX_IMPLEMENT',
  'INTEGRATION',
  'QUALITY_CHECK',
  'CLAUDE_REVIEW',
  'JEV_FINAL_GATE',
  'COMMIT',
  'PUSH',
  'PR_CREATE',
  'CI_WAIT',
  'WAITING_HUMAN',
  'DONE',
  'FAILED',
  'ABORTED',
] as const;

export type HarnessPhase = (typeof HARNESS_PHASES)[number];

export const HARNESS_STATUSES = [
  'CREATED',
  'RUNNING',
  'WAITING',
  'BLOCKED',
  'BUDGET_BLOCKED',
  'FAILED',
  'COMPLETED',
  'ABORTED',
] as const;

export type HarnessTaskStatus = (typeof HARNESS_STATUSES)[number];

export interface HarnessTaskRecord {
  id: string;
  title: string;
  requestHash: string;
  requestLength: number;
  projectRoot: string;
  status: HarnessTaskStatus;
  phase: HarnessPhase;
  lastSafePhase: HarnessPhase;
  route?: string;
  retry: number;
  maxRetry: number;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  metadata: Record<string, unknown>;
}

export interface CreateHarnessTaskInput {
  requestHash: string;
  requestLength: number;
  projectRoot: string;
  maxRetry: number;
  createdAt: string;
}

export interface HarnessTaskPatch {
  title?: string;
  status?: HarnessTaskStatus;
  phase?: HarnessPhase;
  lastSafePhase?: HarnessPhase;
  route?: string;
  retry?: number;
  updatedAt: string;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface HarnessTaskQuery {
  status?: HarnessTaskStatus;
  limit?: number;
}

export interface HarnessPhaseEvent {
  taskId: string;
  fromPhase: HarnessPhase;
  toPhase: HarnessPhase;
  status: HarnessTaskStatus;
  createdAt: string;
}
