import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createHarnessContext } from './context.js';
import { DASHBOARD_HTML } from './dashboard-page.js';
import { GitHubManager } from './github-manager.js';
import { HarnessGitManager, projectWorktreeRoot, type TaskWorktrees } from './git-manager.js';
import { HarnessTaskLog } from './task-log.js';
import type { HarnessTaskRecord } from './types.js';
import { saveHarnessConfig } from './config.js';

export interface DashboardHandle {
  port: number;
  close(): Promise<void>;
}

export async function startDashboard(projectRoot: string, port = 4321): Promise<DashboardHandle> {
  const context = createHarnessContext(projectRoot);
  const csrfToken = randomBytes(32).toString('base64url');
  const inFlight = new Set<Promise<unknown>>();
  const server = createServer(async (request, response) => {
    try {
      await route(context, request, response, csrfToken, inFlight);
    } catch (cause) {
      json(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...inFlight]);
      context.state.close();
    },
  };
}

type HarnessContext = ReturnType<typeof createHarnessContext>;

async function route(
  ctx: HarnessContext,
  request: IncomingMessage,
  response: ServerResponse,
  csrfToken: string,
  inFlight: Set<Promise<unknown>>,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!validHost(request.headers.host)) return json(response, 403, { error: 'invalid host' });
  if (request.method === 'GET' && url.pathname === '/') return html(response, DASHBOARD_HTML.replace('__HARNESS_CSRF_TOKEN__', csrfToken));
  if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, overview(ctx));
  if (request.method === 'GET' && url.pathname === '/api/events') return stream(ctx, request, response);
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    if (!validMutation(request, csrfToken)) return json(response, 403, { error: 'invalid dashboard mutation request' });
    const body = await readJson(request);
    if (body['jev'] && typeof body['jev'] === 'object') delete (body['jev'] as Record<string, unknown>)['configured'];
    const config = saveHarnessConfig(ctx.projectRoot, body);
    Object.assign(ctx.config, config);
    return json(response, 200, redactConfig(config));
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    if (!validMutation(request, csrfToken)) return json(response, 403, { error: 'invalid dashboard mutation request' });
    const body = await readJson(request);
    if (typeof body['task'] !== 'string' || !body['task'].trim()) return json(response, 400, { error: 'task is required' });
    const task = ctx.workflow.create(body['task']);
    const execution = ctx.workflow.execute(task.id, body['task']).catch(() => undefined).finally(() => inFlight.delete(execution));
    inFlight.add(execution);
    return json(response, 202, task);
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)$/);
  if (request.method === 'GET' && taskMatch) {
    const task = ctx.tasks.get(taskMatch[1]!);
    const integration = integrationMetadata(task.metadata);
    let diff: string | null = null;
    if (integration) {
      try {
        diff = await new HarnessGitManager(
          ctx.projectRoot,
          projectWorktreeRoot(ctx.projectRoot, ctx.config.git.worktree_directory),
        ).diff(integration);
      } catch {
        diff = null;
      }
    }
    return json(response, 200, {
      task: taskView(task),
      originalRequest: null,
      requestPolicy: 'Raw requests are encrypted locally for resume and are not returned by the dashboard API.',
      usage: ctx.telemetry.summary(task.id),
      route: task.metadata['route'],
      dag: task.metadata['dag'] ?? null,
      quality: task.metadata['quality'] ?? null,
      review: task.metadata['review'] ?? null,
      finalGate: task.metadata['finalGate'] ?? null,
      pullRequest: task.metadata['pullRequest'] ?? null,
      ci: task.metadata['ci'] ?? null,
      worktrees: task.metadata['worktrees'] ?? [],
      changedFiles: task.metadata['changedFiles'] ?? [],
      diff,
      logs: readTaskLogs(ctx.projectRoot, task.id),
    });
  }
  const retryMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)\/retry$/);
  if (request.method === 'POST' && retryMatch) {
    if (!validMutation(request, csrfToken)) return json(response, 403, { error: 'invalid dashboard mutation request' });
    return json(response, 200, await ctx.workflow.retry(retryMatch[1]!));
  }
  const ciMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)\/ci$/);
  if (request.method === 'GET' && ciMatch) {
    const task = ctx.tasks.get(ciMatch[1]!);
    const delivery = deliveryMetadata(task.metadata);
    const checks = await new GitHubManager(delivery.integrationPath).requiredChecks(delivery.branch);
    return json(response, 200, { checks, readyToMerge: checks.every((check) => check.bucket === 'pass' || check.bucket === 'skipping') });
  }
  const mergeMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)\/merge$/);
  if (request.method === 'POST' && mergeMatch) {
    if (!validMutation(request, csrfToken)) return json(response, 403, { error: 'invalid dashboard mutation request' });
    const task = ctx.tasks.get(mergeMatch[1]!);
    const delivery = deliveryMetadata(task.metadata);
    await new GitHubManager(delivery.integrationPath).mergeAfterHumanApproval(task.id, delivery.branch, delivery.revision, delivery.baseBranch);
    return json(response, 200, ctx.tasks.finishAfterVerifiedMerge(task.id));
  }
  json(response, 404, { error: 'not found' });
}

function overview(ctx: HarnessContext) {
  const tasks = ctx.tasks.list({ limit: 200 });
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const usage = tasks.map((task) => ctx.telemetry.summary(task.id));
  const active = ctx.telemetry.active();
  const activeNames = new Set(active.map((call) => call.agent));
  const lastStatuses = new Map(ctx.telemetry.latestStatuses().map((call) => [call.agent, call.status]));
  return {
    overview: { ...counts, activeAgents: active.length },
    tasks: tasks.map(taskView),
    agents: ['claude-architect', 'claude-reviewer', 'claude-specialist', 'codex-1', 'codex-2', 'codex-3'].map((name) => ({
      name,
      status: activeNames.has(name) ? 'working' : dashboardAgentStatus(lastStatuses.get(name)),
    })),
    usage,
    usageTotals: usageWindows(ctx, tasks),
    config: redactConfig(ctx.config),
  };
}

function dashboardAgentStatus(status: 'success' | 'failed' | 'blocked' | 'timeout' | undefined): 'idle' | 'done' | 'failed' | 'blocked' {
  if (status === 'success') return 'done';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed' || status === 'timeout') return 'failed';
  return 'idle';
}

const PHASE_PROGRESS: Record<string, number> = {
  CREATED: 0, ROUTING: 5, PLANNING: 15, DAG_CREATED: 20, CODEX_IMPLEMENT: 45,
  INTEGRATION: 60, QUALITY_CHECK: 75, CLAUDE_REVIEW: 85, JEV_FINAL_GATE: 90,
  COMMIT: 92, PUSH: 94, PR_CREATE: 96, CI_WAIT: 98, WAITING_HUMAN: 99,
  DONE: 100, FAILED: 100, ABORTED: 100,
};

function taskView(task: HarnessTaskRecord) {
  return {
    ...task,
    progress: taskProgress(task),
    elapsedMs: Math.max(0, Date.now() - Date.parse(task.createdAt)),
    agentCount: Array.isArray(task.metadata['dag']) ? task.metadata['dag'].length : 0,
  };
}

function taskProgress(task: HarnessTaskRecord): number {
  if (task.status === 'COMPLETED') return 100;
  const phase = task.phase === 'FAILED' || task.phase === 'ABORTED' ? task.lastSafePhase : task.phase;
  if (phase === 'CODEX_IMPLEMENT' && Array.isArray(task.metadata['dag']) && task.metadata['dag'].length > 0) {
    const done = task.metadata['dag'].filter((entry) => entry && typeof entry === 'object' && ['SUCCESS', 'FAILED', 'SKIPPED'].includes(String((entry as Record<string, unknown>)['state']))).length;
    return Math.min(59, 20 + Math.floor(39 * done / task.metadata['dag'].length));
  }
  return PHASE_PROGRESS[phase] ?? 0;
}

function usageWindows(ctx: HarnessContext, tasks: HarnessTaskRecord[]) {
  const now = Date.now();
  return {
    today: ctx.telemetry.totalsSince(new Date(now - 24 * 60 * 60_000)),
    week: ctx.telemetry.totalsSince(new Date(now - 7 * 24 * 60 * 60_000)),
    retryOverhead: tasks.reduce((sum, task) => sum + task.retry + Number(task.metadata['subtaskRetryCount'] ?? 0), 0),
  };
}

function stream(ctx: HarnessContext, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = () => response.write(`data: ${JSON.stringify(overview(ctx))}\n\n`);
  send();
  const timer = setInterval(send, 3_000);
  request.once('close', () => clearInterval(timer));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 64 * 1024) throw new Error('request body too large');
  }
  return JSON.parse(body || '{}') as Record<string, unknown>;
}

function redactConfig(config: HarnessContext['config']) {
  return { ...config, jev: { ...config.jev, api_key_env: config.jev.api_key_env, configured: Boolean(process.env[config.jev.api_key_env]) } };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
  response.end(value);
}

function validHost(host: string | undefined): boolean {
  return Boolean(host && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host));
}

function validMutation(request: IncomingMessage, expectedToken: string): boolean {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) return false;
  const supplied = request.headers['x-harness-csrf'];
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function deliveryMetadata(metadata: Record<string, unknown>): { branch: string; integrationPath: string; revision: string; baseBranch?: string } {
  const delivery = metadata['delivery'];
  if (!delivery || typeof delivery !== 'object') throw new Error('Task has no GitHub delivery metadata.');
  const value = delivery as Record<string, unknown>;
  if (typeof value['branch'] !== 'string' || typeof value['integrationPath'] !== 'string' || typeof value['revision'] !== 'string') {
    throw new Error('Task GitHub delivery metadata is incomplete.');
  }
  return {
    branch: value['branch'],
    integrationPath: value['integrationPath'],
    revision: value['revision'],
    baseBranch: typeof value['baseBranch'] === 'string' ? value['baseBranch'] : undefined,
  };
}

function integrationMetadata(metadata: Record<string, unknown>): TaskWorktrees | undefined {
  const integration = metadata['integration'];
  if (!integration || typeof integration !== 'object') return undefined;
  const value = integration as Record<string, unknown>;
  if (
    typeof value['taskId'] !== 'string' || typeof value['integrationBranch'] !== 'string' ||
    typeof value['integrationPath'] !== 'string' || typeof value['baseRef'] !== 'string'
  ) return undefined;
  return value as unknown as TaskWorktrees;
}

function readTaskLogs(projectRoot: string, taskId: string): string {
  try {
    return new HarnessTaskLog(projectRoot).read(taskId);
  } catch {
    return '';
  }
}
