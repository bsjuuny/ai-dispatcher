import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResumeEnvelopeStore } from '../../src/harness/resume-envelope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ResumeEnvelopeStore', () => {
  it('round-trips task input without persisting plaintext', () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-envelope-'));
    roots.push(root);
    const store = new ResumeEnvelopeStore(root);
    const envelope = store.seal('Fix sensitive login behavior');
    expect(envelope).not.toContain('sensitive');
    expect(store.open(envelope)).toBe('Fix sensitive login behavior');
    expect(readFileSync(join(root, '.ai-harness', 'resume.key'))).toHaveLength(32);
  });

  it('fails closed when another project key tries to decrypt an envelope', () => {
    const first = mkdtempSync(join(tmpdir(), 'resume-envelope-a-'));
    const second = mkdtempSync(join(tmpdir(), 'resume-envelope-b-'));
    roots.push(first, second);
    const envelope = new ResumeEnvelopeStore(first).seal('task');
    expect(() => new ResumeEnvelopeStore(second).open(envelope)).toThrow(/missing, corrupt, or belongs/);
  });
});
