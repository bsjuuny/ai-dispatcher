import { DispatcherError } from '../models/error.js';
import { runProcess, type ProcessOutcome, type ProcessPlan } from '../process/process-runner.js';

export type HerdrAgentKind = 'claude' | 'codex';
export type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown';

export interface HerdrAdapterConfig {
  executable: string;
  session?: string;
  commandTimeoutMs: number;
  agentStartupTimeoutMs: number;
}

export interface HerdrSessionInfo {
  name: string;
  running: boolean;
  default?: boolean;
  socketPath?: string;
}

export interface HerdrWorkspace {
  workspaceId: string;
  rootPaneId: string;
  raw: Record<string, unknown>;
}

export interface HerdrAgentSnapshot {
  name?: string;
  paneId?: string;
  state: HerdrAgentState;
  raw: Record<string, unknown>;
}

export interface StartHerdrAgentInput {
  name: string;
  kind: HerdrAgentKind;
  paneId: string;
  timeoutMs?: number;
  nativeArgs?: string[];
}

export type ProcessExecutor = (plan: ProcessPlan) => Promise<ProcessOutcome>;

/** Stable CLI-wrapper adapter for Herdr 0.8.x. It intentionally depends on the
 * installed binary's JSON surface instead of Herdr internals. */
export class HerdrAdapter {
  constructor(
    private readonly config: HerdrAdapterConfig,
    private readonly execute: ProcessExecutor = runProcess,
  ) {}

  async version(cwd: string): Promise<string> {
    const outcome = await this.run(['--version'], cwd, { scopedSession: false });
    return outcome.stdout.trim();
  }

  async listSessions(cwd: string): Promise<HerdrSessionInfo[]> {
    const result = await this.runJson<{ sessions?: Array<Record<string, unknown>> }>(
      ['session', 'list', '--json'],
      cwd,
      { scopedSession: false },
    );
    return (result.sessions ?? []).map((session) => ({
      name: String(session['name'] ?? ''),
      running: Boolean(session['running']),
      default: session['default'] === undefined ? undefined : Boolean(session['default']),
      socketPath: typeof session['socket_path'] === 'string' ? session['socket_path'] : undefined,
    }));
  }

  async createWorkspace(cwd: string, label: string): Promise<HerdrWorkspace> {
    const response = await this.runJson<Record<string, unknown>>(
      ['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'],
      cwd,
    );
    const result = objectAt(response, 'result');
    const workspace = objectAt(result, 'workspace');
    const rootPane = objectAt(result, 'root_pane');
    return {
      workspaceId: requiredString(workspace, 'workspace_id'),
      rootPaneId: requiredString(rootPane, 'pane_id'),
      raw: response,
    };
  }

  async splitPane(
    cwd: string,
    paneId: string,
    direction: 'right' | 'down',
  ): Promise<string> {
    const response = await this.runJson<Record<string, unknown>>(
      ['pane', 'split', paneId, '--direction', direction, '--cwd', cwd, '--no-focus'],
      cwd,
    );
    return requiredString(objectAt(objectAt(response, 'result'), 'pane'), 'pane_id');
  }

  async startAgent(cwd: string, input: StartHerdrAgentInput): Promise<HerdrAgentSnapshot> {
    const args = [
      'agent',
      'start',
      input.name,
      '--kind',
      input.kind,
      '--pane',
      input.paneId,
      '--timeout',
      String(input.timeoutMs ?? this.config.agentStartupTimeoutMs),
    ];
    if (input.nativeArgs?.length) args.push('--', ...input.nativeArgs);
    const response = await this.runJson<Record<string, unknown>>(args, cwd, {
      timeoutMs: input.timeoutMs ?? this.config.agentStartupTimeoutMs,
    });
    return parseAgentSnapshot(response);
  }

  async prompt(cwd: string, target: string, prompt: string, timeoutMs: number): Promise<HerdrAgentSnapshot> {
    if (Buffer.byteLength(prompt, 'utf8') > 16 * 1024) {
      throw new DispatcherError({
        code: 'HERDR_PROMPT_TOO_LARGE',
        message: 'Herdr CLI prompt exceeds the 16 KiB safe argv limit; reduce it to an artifact reference.',
        retryable: false,
      });
    }
    const response = await this.runJson<Record<string, unknown>>(
      ['agent', 'prompt', target, prompt, '--wait', '--timeout', String(timeoutMs)],
      cwd,
      { timeoutMs },
    );
    return parseAgentSnapshot(response);
  }

  async wait(cwd: string, target: string, timeoutMs: number): Promise<HerdrAgentSnapshot> {
    const response = await this.runJson<Record<string, unknown>>(
      ['agent', 'wait', target, '--timeout', String(timeoutMs)],
      cwd,
      { timeoutMs },
    );
    return parseAgentSnapshot(response);
  }

  async getAgent(cwd: string, target: string): Promise<HerdrAgentSnapshot> {
    return parseAgentSnapshot(
      await this.runJson<Record<string, unknown>>(['agent', 'get', target], cwd),
    );
  }

  async readAgent(cwd: string, target: string, lines = 120): Promise<string> {
    const response = await this.runJson<Record<string, unknown>>(
      ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'],
      cwd,
    );
    const result = objectAt(response, 'result');
    return firstString(result, ['text', 'content', 'output']) ?? '';
  }

  async createWorktree(
    cwd: string,
    branch: string,
    base: string,
    path: string,
    label: string,
  ): Promise<HerdrWorkspace> {
    const response = await this.runJson<Record<string, unknown>>(
      ['worktree', 'create', '--cwd', cwd, '--branch', branch, '--base', base, '--path', path, '--label', label, '--no-focus'],
      cwd,
    );
    const result = objectAt(response, 'result');
    const workspace = objectAt(result, 'workspace');
    const rootPane = objectAt(result, 'root_pane');
    return {
      workspaceId: requiredString(workspace, 'workspace_id'),
      rootPaneId: requiredString(rootPane, 'pane_id'),
      raw: response,
    };
  }

  async removeWorktree(cwd: string, workspaceId: string, force = false): Promise<void> {
    const args = ['worktree', 'remove', '--workspace', workspaceId];
    if (force) args.push('--force');
    await this.runJson(args, cwd);
  }

  private async runJson<T>(
    args: string[],
    cwd: string,
    options: { timeoutMs?: number; scopedSession?: boolean } = {},
  ): Promise<T> {
    const outcome = await this.run(args, cwd, options);
    try {
      return JSON.parse(outcome.stdout.trim()) as T;
    } catch (cause) {
      throw new DispatcherError({
        code: 'HERDR_RESPONSE_INVALID',
        message: `Herdr returned invalid JSON for "${args.slice(0, 2).join(' ')}".`,
        cause,
        retryable: false,
      });
    }
  }

  private async run(
    args: string[],
    cwd: string,
    options: { timeoutMs?: number; scopedSession?: boolean } = {},
  ): Promise<ProcessOutcome> {
    const env = { ...process.env };
    if (options.scopedSession !== false && this.config.session) env['HERDR_SESSION'] = this.config.session;
    const outcome = await this.execute({
      file: this.config.executable,
      args,
      cwd,
      env,
      timeoutMs: options.timeoutMs ?? this.config.commandTimeoutMs,
    });
    if (outcome.timedOut) {
      throw new DispatcherError({
        code: 'HERDR_TIMEOUT',
        message: `Herdr command timed out: ${args.slice(0, 2).join(' ')}`,
        retryable: true,
      });
    }
    if (outcome.exitCode !== 0) {
      const stderr = outcome.stderr.trim();
      throw new DispatcherError({
        code: outcome.exitCode === null ? 'HERDR_NOT_INSTALLED' : 'HERDR_COMMAND_FAILED',
        message: stderr || `Herdr command failed with exit code ${outcome.exitCode}.`,
        retryable: stderr.includes('agent_pane_busy') || stderr.includes('agent_not_ready'),
      });
    }
    return outcome;
  }
}

function parseAgentSnapshot(response: Record<string, unknown>): HerdrAgentSnapshot {
  const result = objectAt(response, 'result');
  const agent = isObject(result['agent']) ? result['agent'] : result;
  const stateValue = firstString(agent, ['state', 'status']) ?? 'unknown';
  const state: HerdrAgentState = ['idle', 'working', 'blocked', 'done', 'failed', 'unknown'].includes(stateValue)
    ? (stateValue as HerdrAgentState)
    : 'unknown';
  return {
    name: firstString(agent, ['name', 'agent_name']),
    paneId: firstString(agent, ['pane_id']),
    state,
    raw: response,
  };
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (!isObject(child)) {
    throw new DispatcherError({
      code: 'HERDR_RESPONSE_INVALID',
      message: `Herdr response is missing object field "${key}".`,
      retryable: false,
    });
  }
  return child;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result) {
    throw new DispatcherError({
      code: 'HERDR_RESPONSE_INVALID',
      message: `Herdr response is missing string field "${key}".`,
      retryable: false,
    });
  }
  return result;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
