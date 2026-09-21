import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDashboard, type DashboardHandle } from '../../src/harness/dashboard-server.js';

let root: string | undefined;
let dashboard: DashboardHandle | undefined;

afterEach(async () => {
  if (dashboard) await dashboard.close();
  if (root) await rm(root, { recursive: true, force: true });
  dashboard = undefined;
  root = undefined;
});

describe('dashboard server', () => {
  it('serves the control center and creates a routed task through the API', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-harness-dashboard-'));
    dashboard = await startDashboard(root, 0);
    const base = `http://127.0.0.1:${dashboard.port}`;

    const page = await fetch(base);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain('AI DEVELOPMENT CONTROL CENTER');
    const csrf = csrfFrom(pageText);

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-csrf': csrf },
      body: JSON.stringify({ task: 'Fix a small display typo' }),
    });
    expect(created.status).toBe(202);
    const task = await created.json() as { id: string; phase: string; metadata: Record<string, unknown> };
    expect(task.id).toMatch(/^TASK-/);
    expect(task.phase).toBe('CREATED');

    const overview = await fetch(`${base}/api/overview`);
    const summary = await overview.json() as { tasks: Array<{ id: string }>; config: { jev: Record<string, unknown> } };
    expect(summary.tasks.map((item) => item.id)).toContain(task.id);
    expect(summary.config.jev['configured']).toBe(false);
    expect(summary.config.jev).not.toHaveProperty('apiKey');

    await waitForTerminal(base, task.id);

    const detail = await fetch(`${base}/api/tasks/${task.id}`);
    const body = await detail.json() as { originalRequest: unknown; requestPolicy: string };
    expect(body.originalRequest).toBeNull();
    expect(body.requestPolicy).toContain('not persisted');

    const retried = await fetch(`${base}/api/tasks/${task.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-csrf': csrf },
      body: '{}',
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'BLOCKED', errorCode: 'RESUME_CONTEXT_MISSING' });
  });

  it('rejects an empty task request', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-harness-dashboard-'));
    dashboard = await startDashboard(root, 0);
    const base = `http://127.0.0.1:${dashboard.port}`;
    const csrf = csrfFrom(await (await fetch(base)).text());
    const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-csrf': csrf },
      body: JSON.stringify({ task: '   ' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects cross-site or tokenless mutations', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-harness-dashboard-'));
    dashboard = await startDashboard(root, 0);
    const base = `http://127.0.0.1:${dashboard.port}`;
    const csrf = csrfFrom(await (await fetch(base)).text());
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-csrf': csrf, origin: 'https://attacker.example' },
      body: JSON.stringify({ task: 'Run attacker input' }),
    });
    expect(response.status).toBe(403);
  });
});

function csrfFrom(page: string): string {
  const value = page.match(/const csrf='([^']+)'/)?.[1];
  if (!value) throw new Error('Dashboard did not embed a CSRF token.');
  return value;
}

async function waitForTerminal(base: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/api/tasks/${taskId}`);
    const detail = await response.json() as { task: { status: string } };
    if (['FAILED', 'BLOCKED', 'BUDGET_BLOCKED', 'WAITING', 'COMPLETED'].includes(detail.task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Dashboard task did not settle.');
}
