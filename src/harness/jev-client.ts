import { DispatcherError } from '../models/error.js';
import { safeHttpFetch } from '../providers/http-client.js';

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevAnswer {
  type?: string;
  choice?: string;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevDecisionResult {
  answers: Record<string, JevAnswer>;
  model?: string;
}

export interface JevDecisionClient {
  isConfigured(): boolean;
  decide(state: Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<JevDecisionResult>;
}

export interface HttpJevDecisionClientConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export class HttpJevDecisionClient implements JevDecisionClient {
  private readonly endpoint: URL;

  constructor(private readonly config: HttpJevDecisionClientConfig) {
    this.endpoint = validateEndpoint(config.endpoint);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async decide(state: Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<JevDecisionResult> {
    if (!this.config.apiKey) {
      throw new DispatcherError({
        code: 'JEV_API_UNAVAILABLE',
        message: 'Jev API key is not configured.',
        retryable: false,
      });
    }
    let response;
    try {
      response = await safeHttpFetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: { model: this.config.model, state, questions },
        timeoutMs: this.config.timeoutMs,
        allowedOrigins: [this.endpoint.origin],
      });
    } catch (cause) {
      if (cause instanceof DispatcherError) throw cause;
      throw new DispatcherError({
        code: 'JEV_API_UNAVAILABLE',
        message: `Jev API request failed: ${(cause as Error).message}`,
        cause,
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new DispatcherError({
        code: 'JEV_API_UNAVAILABLE',
        message: `Jev API returned HTTP ${response.status}.`,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return parseDecisionResponse(response.json);
  }
}

function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Invalid Jev endpoint: ${endpoint}`,
      cause,
      retryable: false,
    });
  }
  if (url.protocol !== 'https:') {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: 'Jev endpoint must use HTTPS.',
      retryable: false,
    });
  }
  return url;
}

function parseDecisionResponse(value: unknown): JevDecisionResult {
  if (!isObject(value)) throw invalidResponse();
  const data = isObject(value['data']) ? value['data'] : value;
  const answers = data['answers'];
  if (!isObject(answers)) throw invalidResponse();
  const parsed: Record<string, JevAnswer> = {};
  for (const [key, answer] of Object.entries(answers)) {
    if (!isObject(answer)) throw invalidResponse();
    parsed[key] = {
      type: stringValue(answer['type']),
      choice: stringValue(answer['choice']),
      noul: numberValue(answer['noul']),
      confidence: numberValue(answer['confidence']),
      probabilities: isObject(answer['probabilities'])
        ? Object.fromEntries(
            Object.entries(answer['probabilities']).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
          )
        : undefined,
    };
  }
  return { answers: parsed, model: stringValue(data['model']) };
}

function invalidResponse(): DispatcherError {
  return new DispatcherError({
    code: 'JEV_RESPONSE_INVALID',
    message: 'Jev response does not contain typed answers.',
    retryable: false,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
