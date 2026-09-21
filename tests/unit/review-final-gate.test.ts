import { describe, expect, it, vi } from 'vitest';
import { parseReview } from '../../src/harness/review-service.js';
import { JevFinalGate } from '../../src/harness/final-gate.js';
import type { JevDecisionClient } from '../../src/harness/jev-client.js';
import type { QualityGateResult } from '../../src/harness/quality-gate.js';

const quality = (passed: boolean, failedStages: QualityGateResult['failedStages'] = []): QualityGateResult => ({
  passed,
  stages: [],
  failedStages,
  durationMs: 1,
});

const client = (configured: boolean, choice = 'PASS'): JevDecisionClient => ({
  isConfigured: () => configured,
  decide: vi.fn().mockResolvedValue({ answers: { decision: { choice, confidence: 0.9 } } }),
});

describe('Claude reviewer parsing', () => {
  it('accepts APPROVE and actionable REVISE results', () => {
    expect(parseReview('{"verdict":"APPROVE","issues":[]}').verdict).toBe('APPROVE');
    expect(parseReview('{"verdict":"REVISE","issues":[{"severity":"high","category":"security","message":"Validate input"}]}').issues).toHaveLength(1);
  });

  it('rejects a non-actionable REVISE result', () => {
    expect(() => parseReview('{"verdict":"REVISE","issues":[]}')).toThrow(/actionable/);
  });
});

describe('JevFinalGate', () => {
  it('passes only when deterministic quality and review evidence pass', async () => {
    const result = await new JevFinalGate(client(false)).decide({
      quality: quality(true),
      review: { verdict: 'APPROVE', issues: [] },
      retry: 0,
      maxRetry: 2,
    });
    expect(result.decision).toBe('PASS');
  });

  it('never lets a Jev PASS override a real quality failure', async () => {
    const jev = client(true, 'PASS');
    const result = await new JevFinalGate(jev).decide({
      quality: quality(false, ['test']),
      review: { verdict: 'APPROVE', issues: [] },
      retry: 0,
      maxRetry: 2,
    });
    expect(result).toMatchObject({ decision: 'RETRY_CODEX', source: 'deterministic-precondition' });
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('escalates security quality failures to Claude', async () => {
    const result = await new JevFinalGate(client(false)).decide({
      quality: quality(false, ['security']),
      review: { verdict: 'APPROVE', issues: [] },
      retry: 0,
      maxRetry: 2,
    });
    expect(result.decision).toBe('ESCALATE_CLAUDE');
  });

  it('routes reviewer implementation findings to Codex and architecture findings to Claude', async () => {
    const codex = await new JevFinalGate(client(false)).decide({
      quality: quality(true),
      review: { verdict: 'REVISE', issues: [{ severity: 'medium', category: 'tests', message: 'Add regression test' }] },
      retry: 0,
      maxRetry: 2,
    });
    const claude = await new JevFinalGate(client(false)).decide({
      quality: quality(true),
      review: { verdict: 'REVISE', issues: [{ severity: 'high', category: 'security', message: 'Threat model missing' }] },
      retry: 0,
      maxRetry: 2,
    });
    expect(codex.decision).toBe('RETRY_CODEX');
    expect(claude.decision).toBe('ESCALATE_CLAUDE');
  });

  it('stops after the retry budget is exhausted', async () => {
    const result = await new JevFinalGate(client(true, 'RETRY_CODEX')).decide({
      quality: quality(true),
      review: { verdict: 'REVISE', issues: [{ severity: 'low', category: 'tests', message: 'missing test' }] },
      retry: 2,
      maxRetry: 2,
    });
    expect(result.decision).toBe('STOP');
  });
});
