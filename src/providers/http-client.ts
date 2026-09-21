import { DispatcherError } from '../models/error.js';

export interface SafeHttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  allowedOrigins: readonly string[];
}

export interface SafeHttpResult {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
}

/** The only source-level fetch() chokepoint. Every caller must provide an exact
 * origin allowlist; redirects are rejected so an approved origin cannot bounce
 * credentials or payloads to another host. */
export async function safeHttpFetch(url: URL, opts: SafeHttpOptions): Promise<SafeHttpResult> {
  if (!opts.allowedOrigins.includes(url.origin)) {
    throw new DispatcherError({
      code: 'HTTP_TARGET_REJECTED',
      message: `HTTP target origin is not allowlisted: ${url.origin}`,
      retryable: false,
    });
  }

  const response = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json };
}
