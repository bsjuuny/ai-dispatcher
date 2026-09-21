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
    expect(await page.text()).toContain('AI DEVELOPMENT CONTROL CENTER');

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Fix a small display typo' }),
    });
    expect(created.status).toBe(201);
    const task = await created.json() as { id: string; phase: string; metadata: Record<string, unknown> };
    expect(task.id).toMatch(/^TASK-/);
    expect(task.phase).toBe('ROUTING');
    expect(task.metadata['route']).toBeDefined();

    const overview = await fetch(`${base}/api/overview`);
    const summary = await overview.json() as { tasks: Array<{ id: string }>; config: { jev: Record<string, unknown> } };
    expect(summary.tasks.map((item) => item.id)).toContain(task.id);
    expect(summary.config.jev['configured']).toBe(false);
    expect(summary.config.jev).not.toHaveProperty('apiKey');

    const detail = await fetch(`${base}/api/tasks/${task.id}`);
    const body = await detail.json() as { originalRequest: unknown; requestPolicy: string };
    expect(body.originalRequest).toBeNull();
    expect(body.requestPolicy).toContain('not persisted');
  });

  it('rejects an empty task request', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-harness-dashboard-'));
    dashboard = await startDashboard(root, 0);
    const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: '   ' }),
    });
    expect(response.status).toBe(400);
  });
});
