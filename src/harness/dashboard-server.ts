import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHarnessContext } from './context.js';
import { DASHBOARD_HTML } from './dashboard-page.js';

export interface DashboardHandle {
  port: number;
  close(): Promise<void>;
}

export async function startDashboard(projectRoot: string, port = 4321): Promise<DashboardHandle> {
  const context = createHarnessContext(projectRoot);
  const server = createServer(async (request, response) => {
    try {
      await route(context, request, response);
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        context.state.close();
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

type HarnessContext = ReturnType<typeof createHarnessContext>;

async function route(ctx: HarnessContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') return html(response, DASHBOARD_HTML);
  if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, overview(ctx));
  if (request.method === 'GET' && url.pathname === '/api/events') return stream(ctx, request, response);
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJson(request);
    if (typeof body['task'] !== 'string' || !body['task'].trim()) return json(response, 400, { error: 'task is required' });
    const task = ctx.tasks.create(body['task'], ctx.projectRoot);
    ctx.tasks.enterPhase(task.id, 'ROUTING');
    const routeResult = await ctx.jev.route({ task: body['task'] });
    return json(response, 201, ctx.tasks.recordRoute(task.id, routeResult as unknown as Record<string, unknown> & { complexity: string }));
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)$/);
  if (request.method === 'GET' && taskMatch) {
    const task = ctx.tasks.get(taskMatch[1]!);
    return json(response, 200, {
      task,
      originalRequest: null,
      requestPolicy: 'Raw requests are not persisted by default; only hash and length are stored.',
      usage: ctx.telemetry.summary(task.id),
      route: task.metadata['route'],
      dag: task.metadata['dag'] ?? null,
      quality: task.metadata['quality'] ?? null,
      review: task.metadata['review'] ?? null,
      finalGate: task.metadata['finalGate'] ?? null,
      pullRequest: task.metadata['pullRequest'] ?? null,
    });
  }
  const retryMatch = url.pathname.match(/^\/api\/tasks\/(TASK-[A-Za-z0-9-]+)\/retry$/);
  if (request.method === 'POST' && retryMatch) {
    return json(response, 200, ctx.tasks.retry(retryMatch[1]!));
  }
  json(response, 404, { error: 'not found' });
}

function overview(ctx: HarnessContext) {
  const tasks = ctx.tasks.list({ limit: 200 });
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const usage = tasks.map((task) => ctx.telemetry.summary(task.id));
  return {
    overview: { ...counts, activeAgents: 0 },
    tasks,
    agents: ['claude-architect', 'claude-reviewer', 'claude-specialist', 'codex-1', 'codex-2', 'codex-3'].map((name) => ({ name, status: 'idle' })),
    usage,
    config: redactConfig(ctx.config),
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
