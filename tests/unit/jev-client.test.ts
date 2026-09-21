import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpJevDecisionClient } from '../../src/harness/jev-client.js';

describe('HttpJevDecisionClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires HTTPS endpoints', () => {
    expect(() => new HttpJevDecisionClient({ endpoint: 'http://jev.example/api', apiKey: 'x', model: 'jev', timeoutMs: 1000 })).toThrow(/HTTPS/);
  });

  it('reports an unconfigured key without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpJevDecisionClient({ endpoint: 'https://www.jevai.org/api/v1/decisions', model: 'typesafe-ai/jev', timeoutMs: 1000 });
    await expect(client.decide({}, {})).rejects.toMatchObject({ code: 'JEV_API_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses typed decision answers from the API data envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { model: 'typesafe-ai/jev', answers: { complexity: { type: 'choice', choice: 'complex', confidence: 0.9 } } },
    }), { status: 200 })));
    const client = new HttpJevDecisionClient({ endpoint: 'https://www.jevai.org/api/v1/decisions', apiKey: 'secret', model: 'typesafe-ai/jev', timeoutMs: 1000 });
    const result = await client.decide({ task: 'x' }, {});
    expect(result).toEqual({
      model: 'typesafe-ai/jev',
      answers: { complexity: { type: 'choice', choice: 'complex', confidence: 0.9, noul: undefined, probabilities: undefined } },
    });
  });
});
