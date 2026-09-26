import { execa } from 'execa';
import { DispatcherError } from '../models/error.js';

/**
 * The ONLY file in this codebase allowed to import execa/child_process (enforced by
 * eslint no-restricted-imports elsewhere, and by a dist/*.js static-scan test after
 * build). Every provider command reaches the OS exclusively through this function.
 *
 * `shell` is passed explicitly as `false` even though it is execa's default - so a
 * future edit "fixing a quoting bug" can't silently flip it to `true` and reintroduce
 * shell interpretation of user-controlled argv elements.
 */

export interface ProcessPlan {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  idleTimeoutMs?: number;
  stdinContent?: string;
  signal?: AbortSignal;
  onActivity?: (activity: ProcessActivity) => void;
}

export interface ProcessActivity {
  stream: 'stdout' | 'stderr';
  bytes: number;
  elapsedMs: number;
  at: string;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutReason?: 'idle' | 'hard';
  activityCount?: number;
  lastActivityAt?: string;
  treeTermination?: 'succeeded' | 'fallback';
  treeTerminationMessage?: string;
  durationMs: number;
}

export interface ManagedProcess {
  readonly pid?: number;
  readonly completion: Promise<ProcessOutcome>;
  hasExited(): boolean;
  stop(): Promise<void>;
}

/** Starts a deliberately long-running, argv-only process while preserving the
 * repository's single process-spawn chokepoint. Used for local model servers. */
export function startManagedProcess(plan: Pick<ProcessPlan, 'file' | 'args' | 'cwd' | 'env'>): ManagedProcess {
  assertArgvIsStringArray(plan.args);
  const startedAt = Date.now();
  const subprocess = execa(plan.file, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    reject: false,
    stdio: 'inherit',
    killDescendants: true,
  });
  let exited = false;
  const completion = subprocess.then((result): ProcessOutcome => {
    if (result.failed && result.exitCode === undefined) {
      throw new DispatcherError({
        code: 'PROCESS_START_FAILED',
        message: `Failed to start process "${plan.file}": ${result.shortMessage}`,
        retryable: true,
        severity: 'error',
      });
    }
    return {
      exitCode: result.exitCode ?? null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  }).catch((cause: unknown) => {
    if (cause instanceof DispatcherError) throw cause;
    throw new DispatcherError({
      code: 'PROCESS_START_FAILED',
      message: `Failed to start process "${plan.file}": ${(cause as Error).message}`,
      cause,
      retryable: true,
      severity: 'error',
    });
  }).finally(() => {
    exited = true;
  });
  // Mark the rejection as observed immediately. Callers still receive the
  // original rejecting `completion`, but a fast spawn failure cannot become an
  // unhandled rejection while a readiness loop is still polling.
  void completion.catch(() => undefined);

  return {
    pid: subprocess.pid,
    completion,
    hasExited: () => exited,
    stop: async () => {
      if (!exited) await terminateProcessTree(subprocess.pid, () => subprocess.kill('SIGTERM'));
      await completion.catch(() => undefined);
    },
  };
}

export async function runProcess(plan: ProcessPlan): Promise<ProcessOutcome> {
  assertArgvIsStringArray(plan.args);
  const startedAt = Date.now();
  let hardTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let timeoutReason: ProcessOutcome['timeoutReason'];
  let activityCount = 0;
  let lastActivityAt: string | undefined;
  let treeTermination: ProcessOutcome['treeTermination'];
  let treeTerminationMessage: string | undefined;
  let terminationPromise: Promise<void> | undefined;

  try {
    const subprocess = execa(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      input: plan.stdinContent,
      cancelSignal: plan.signal,
      reject: false,
      // Without this, execa's timeout/cancel kill only terminates the process it
      // directly spawned, not any further descendants - live-reproduced (2026-08-22):
      // `codex` on Windows is an npm .cmd shim -> node -> a native worker binary, and
      // when the worker hung on a stalled network call, killing just the direct child
      // left the worker alive holding the inherited stdout/stderr pipes open, which
      // kept execa's own promise waiting for EOF that would never come - the
      // configured timeoutMs never actually ended the call, well past 2x the timeout.
      // killDescendants uses `taskkill /T /F` on Windows / a process-group signal on
      // Unix to reach the whole tree instead of just the immediate child.
      killDescendants: true,
    });

    const terminate = (reason: NonNullable<ProcessOutcome['timeoutReason']>): void => {
      if (timeoutReason) return;
      timeoutReason = reason;
      if (idleTimer) clearTimeout(idleTimer);
      terminationPromise = terminateProcessTree(subprocess.pid, () => subprocess.kill('SIGKILL')).then((result) => {
        treeTermination = result.succeeded ? 'succeeded' : 'fallback';
        treeTerminationMessage = result.message;
      }).finally(() => {
        // If a descendant inherited the pipes but tree termination failed, closing
        // our stream handles prevents the await below from hanging forever on EOF.
        setTimeout(() => {
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
          subprocess.kill('SIGKILL');
        }, 1_000).unref();
      });
    };

    const armIdleTimer = (): void => {
      if (!plan.idleTimeoutMs || timeoutReason) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate('idle'), plan.idleTimeoutMs);
      idleTimer.unref();
    };

    const activity = (stream: ProcessActivity['stream'], chunk: unknown): void => {
      activityCount += 1;
      lastActivityAt = new Date().toISOString();
      armIdleTimer();
      plan.onActivity?.({
        stream,
        bytes: Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk)),
        elapsedMs: Date.now() - startedAt,
        at: lastActivityAt,
      });
    };

    subprocess.stdout?.on('data', (chunk) => activity('stdout', chunk));
    subprocess.stderr?.on('data', (chunk) => activity('stderr', chunk));
    armIdleTimer();
    hardTimer = setTimeout(() => terminate('hard'), plan.timeoutMs);
    hardTimer.unref();

    const result = await subprocess;
    await terminationPromise;

    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: timeoutReason !== undefined || (result.timedOut ?? false),
      timeoutReason,
      activityCount,
      lastActivityAt,
      treeTermination,
      treeTerminationMessage,
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    if (isAbortError(cause)) {
      throw new DispatcherError({
        code: 'PROCESS_CANCELLED',
        message: `Process cancelled: ${plan.file}`,
        cause,
        retryable: false,
      });
    }
    throw new DispatcherError({
      code: 'PROCESS_START_FAILED',
      message: `Failed to start process "${plan.file}": ${(cause as Error).message}`,
      cause,
      retryable: true,
      severity: 'error',
    });
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function terminateProcessTree(
  pid: number | undefined,
  killDirect: () => boolean,
): Promise<{ succeeded: boolean; message?: string }> {
  if (!pid) {
    killDirect();
    return { succeeded: false, message: 'Spawned process did not expose a PID.' };
  }

  if (process.platform === 'win32') {
    try {
      const outcome = await execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
        reject: false,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      });
      if (outcome.exitCode === 0) return { succeeded: true };
      const nativeResult = await terminateWindowsProcessTree(pid);
      if (nativeResult.succeeded) return nativeResult;
      killDirect();
      return {
        succeeded: false,
        message: [
          outcome.stderr.trim() || `taskkill exited with code ${outcome.exitCode}`,
          nativeResult.message,
        ].filter(Boolean).join(' Native fallback: '),
      };
    } catch (cause) {
      const nativeResult = await terminateWindowsProcessTree(pid);
      if (nativeResult.succeeded) return nativeResult;
      killDirect();
      return {
        succeeded: false,
        message: `${(cause as Error).message}. Native fallback: ${nativeResult.message ?? 'failed'}`,
      };
    }
  }

  killDirect();
  return { succeeded: true };
}

async function terminateWindowsProcessTree(pid: number): Promise<{ succeeded: boolean; message?: string }> {
  try {
    const { getProcessList } = await import('@vscode/windows-process-tree');
    const processes = await new Promise<Array<{ pid: number }> | undefined>((resolve) => {
      getProcessList(pid, (list) => resolve(list));
    });
    if (!processes || processes.length === 0) {
      return { succeeded: false, message: 'Windows process tree enumeration returned no processes.' };
    }

    const ordered = [
      ...processes.filter((processInfo) => processInfo.pid !== pid),
      ...processes.filter((processInfo) => processInfo.pid === pid),
    ];
    const failures: string[] = [];
    for (const processInfo of ordered) {
      if (processInfo.pid <= 0 || processInfo.pid === process.pid) continue;
      try {
        process.kill(processInfo.pid, 'SIGKILL');
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') failures.push(`${processInfo.pid}: ${(cause as Error).message}`);
      }
    }

    return failures.length === 0
      ? { succeeded: true }
      : { succeeded: false, message: failures.join('; ') };
  } catch (cause) {
    return { succeeded: false, message: (cause as Error).message };
  }
}

function isAbortError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    ('name' in cause ? cause.name === 'AbortError' : false)
  );
}

/**
 * Defensive guard used by runProcess: proves at runtime that argv is really a flat
 * array of strings, never a pre-joined shell string. This is what makes the
 * shell-injection test suite meaningful - it fails loudly if anything ever tries to
 * pass a single concatenated command string through this path.
 */
export function assertArgvIsStringArray(args: unknown): asserts args is string[] {
  if (!Array.isArray(args)) {
    throw new DispatcherError({
      code: 'INTERNAL_LOGIC_ERROR',
      message: 'Process argv must be an array, not a pre-joined string.',
      retryable: false,
    });
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new DispatcherError({
        code: 'INTERNAL_LOGIC_ERROR',
        message: `Process argv element is not a string: ${typeof arg}`,
        retryable: false,
      });
    }
  }
}
