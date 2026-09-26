import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/schema.js';
import { runOfflinePreflight } from '../../src/local/preflight.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-preflight-git-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('preflight git detection', () => {
  it('reports git as available from the bundled runtime/git/cmd copy, even with an empty PATH', () => {
    const root = tempRoot();
    const bundledDirectory = process.platform === 'win32'
      ? join(root, 'runtime', 'git', 'cmd')
      : join(root, 'runtime', 'git', 'bin');
    const bundledExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
    mkdirSync(bundledDirectory, { recursive: true });
    writeFileSync(join(bundledDirectory, bundledExecutable), 'fake-git');
    const config = parseConfig({});

    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const report = runOfflinePreflight(root, config);
      expect(report.git).toEqual({ available: true, source: 'bundled' });
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('reports git as unavailable when neither bundled nor on PATH', () => {
    const root = tempRoot();
    const config = parseConfig({});

    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const report = runOfflinePreflight(root, config);
      expect(report.git).toEqual({ available: false });
      expect(report.overall.reasons.some((reason) => reason.includes('git was not found'))).toBe(true);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('falls back to a system git found on PATH when nothing is bundled', () => {
    const root = tempRoot();
    const fakePathDir = join(root, 'fake-system-path');
    mkdirSync(fakePathDir, { recursive: true });
    writeFileSync(join(fakePathDir, process.platform === 'win32' ? 'git.exe' : 'git'), 'fake-git');
    const config = parseConfig({});

    const originalPath = process.env['PATH'];
    process.env['PATH'] = fakePathDir;
    try {
      const report = runOfflinePreflight(root, config);
      expect(report.git).toEqual({ available: true, source: 'path' });
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
