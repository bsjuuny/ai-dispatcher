import type { ProviderId } from './provider.js';

export type DispatcherErrorCode =
  | 'PROVIDER_NOT_INSTALLED'
  | 'PROVIDER_NOT_AUTHENTICATED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROCESS_START_FAILED'
  | 'PROCESS_EXIT_ERROR'
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_CANCELLED'
  | 'OUTPUT_PARSE_FAILED'
  | 'INVALID_PROVIDER_OUTPUT'
  | 'INVALID_TASK'
  | 'TASK_INPUT_EMPTY'
  | 'TASK_NOT_FOUND'
  | 'TASK_INPUT_TOO_LARGE'
  | 'ATTACHMENT_READ_FAILED'
  | 'INVALID_WORKING_DIRECTORY'
  | 'PATH_TRAVERSAL_REJECTED'
  | 'CONFIG_INVALID'
  | 'NO_AVAILABLE_PROVIDER'
  | 'VALIDATION_FAILED'
  | 'REVIEW_FAILED'
  | 'AUDIT_WRITE_FAILED'
  | 'HISTORY_WRITE_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'INTERNAL_LOGIC_ERROR'
  // Local LLM Adapter + Hardening increment (additive - see docs/architecture.md).
  | 'LOCAL_RUNTIME_UNREACHABLE'
  | 'LOCAL_RUNTIME_NOT_CONFIGURED'
  | 'LOCAL_MODEL_NOT_FOUND'
  | 'LOCAL_GENERATION_FAILED'
  | 'LOCAL_AGENT_INVALID_ACTION'
  | 'LOCAL_AGENT_LIMIT_EXCEEDED'
  | 'LOCAL_AGENT_NO_CHANGES'
  | 'LOCAL_FETCH_TARGET_REJECTED'
  | 'CPU_RUNTIME_UNSUPPORTED'
  | 'CPU_INSTRUCTION_SET_UNSUPPORTED'
  | 'MODEL_PACK_NOT_AVAILABLE'
  | 'MODEL_NOT_RECOMMENDED_FOR_HARDWARE'
  | 'HARDWARE_PROFILE_UNKNOWN'
  | 'LOCAL_INFERENCE_TOO_SLOW'
  | 'HARDWARE_QUALIFICATION_STALE'
  | 'WORKSPACE_ACQUIRE_FAILED'
  | 'WORKSPACE_RELEASE_FAILED'
  | 'REPOSITORY_LOCKED'
  | 'BASE_REVISION_CHANGED'
  | 'STALE_PATCH'
  | 'PATCH_APPLY_FAILED'
  | 'HERDR_NOT_INSTALLED'
  | 'HERDR_COMMAND_FAILED'
  | 'HERDR_RESPONSE_INVALID'
  | 'HERDR_TIMEOUT'
  | 'HERDR_PROMPT_TOO_LARGE'
  | 'HTTP_TARGET_REJECTED'
  | 'JEV_API_UNAVAILABLE'
  | 'JEV_RESPONSE_INVALID'
  | 'DAG_INVALID'
  | 'AGENT_OUTPUT_INVALID'
  | 'AGENT_BLOCKED'
  | 'AGENT_FAILED'
  | 'GIT_REPO_MISSING'
  | 'WORKTREE_CREATE_FAILED'
  | 'GIT_COMMAND_FAILED'
  | 'SAFETY_POLICY_VIOLATION'
  | 'QUALITY_COMMAND_INVALID'
  | 'QUALITY_COMMAND_MISSING';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface DispatcherErrorParams {
  code: DispatcherErrorCode;
  message: string;
  cause?: unknown;
  taskId?: string;
  executionId?: string;
  provider?: ProviderId;
  retryable: boolean;
  severity?: ErrorSeverity;
}

/**
 * The single error type raised across the dispatcher. `retryable` is set explicitly
 * at every construction site (not derived from a code->boolean lookup table) so the
 * decision lives next to the context that actually knows whether retrying makes sense
 * - a lookup table drifts out of sync with call sites over time; this can't.
 */
export class DispatcherError extends Error {
  readonly code: DispatcherErrorCode;
  readonly taskId?: string;
  readonly executionId?: string;
  readonly provider?: ProviderId;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
  readonly timestamp: string;
  override readonly cause?: unknown;

  constructor(params: DispatcherErrorParams) {
    super(params.message);
    this.name = 'DispatcherError';
    this.code = params.code;
    this.taskId = params.taskId;
    this.executionId = params.executionId;
    this.provider = params.provider;
    this.retryable = params.retryable;
    this.severity = params.severity ?? 'error';
    this.timestamp = new Date().toISOString();
    this.cause = params.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      taskId: this.taskId,
      executionId: this.executionId,
      provider: this.provider,
      retryable: this.retryable,
      severity: this.severity,
      timestamp: this.timestamp,
    };
  }
}

export function isDispatcherError(value: unknown): value is DispatcherError {
  return value instanceof DispatcherError;
}

/**
 * Wraps any thrown value into a DispatcherError so callers never have a bare
 * catch block that silently swallows it. Unknown errors are non-retryable by
 * default since we cannot prove retrying would help.
 */
export function wrapUnknownError(
  value: unknown,
  context: { taskId?: string; executionId?: string; provider?: ProviderId } = {},
): DispatcherError {
  if (isDispatcherError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new DispatcherError({
    code: 'INTERNAL_LOGIC_ERROR',
    message,
    cause: value,
    retryable: false,
    ...context,
  });
}
