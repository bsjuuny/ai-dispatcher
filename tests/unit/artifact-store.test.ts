import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/harness/artifact-store.js';

describe('ArtifactStore', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('writes and reads task JSON artifacts without leaving a temp file', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore(root);
    const path = store.writeJson('TASK-001', 'plan', { tasks: [{ id: 'T1' }] });
    expect(store.readJson('TASK-001', 'plan')).toEqual({ tasks: [{ id: 'T1' }] });
    expect(readFileSync(path, 'utf8')).toContain('"T1"');
  });

  it('rejects path traversal segments', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-artifacts-'));
    roots.push(root);
    expect(() => new ArtifactStore(root).writeJson('TASK-../../x', 'plan', {})).toThrow(/Invalid artifact/);
  });
});
