import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowLeaseManager } from '../../src/harness/workflow-lease.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkflowLeaseManager', () => {
  it('prevents duplicate execution and releases only its own lease', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-lease-'));
    roots.push(root);
    const manager = new WorkflowLeaseManager(root);
    const lease = manager.acquire('TASK-001');
    expect(() => manager.acquire('TASK-001')).toThrow(/already running/);
    manager.release(lease);
    expect(() => manager.acquire('TASK-001')).not.toThrow();
  });

  it('recovers a stale lease owned by a dead process', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-lease-stale-'));
    roots.push(root);
    const locks = join(root, '.ai-harness', 'locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, 'TASK-002.lock'), JSON.stringify({ token: 'old', pid: 2147483647 }));
    expect(new WorkflowLeaseManager(root).acquire('TASK-002').token).not.toBe('old');
  });
});
