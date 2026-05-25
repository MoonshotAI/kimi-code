import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchSubmitFeedback,
  kimiCodeFeedbackUrl,
  type SubmitFeedbackBody,
} from '../src/managed-feedback';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SAMPLE_BODY: SubmitFeedbackBody = {
  session_id: 'sess-123',
  content: 'great tool',
  version: 'kimi-code-0.1.1',
  os: 'Darwin 25.3.0',
  model: 'kimi-code/kimi-for-coding',
};

describe('kimiCodeFeedbackUrl', () => {
  it('appends /feedback to the default base URL', () => {
    expect(kimiCodeFeedbackUrl()).toBe('https://api.kimi.com/coding/v1/feedback');
  });

  it('honours KIMI_CODE_BASE_URL and trims trailing slashes', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://example.test/v9///');
    expect(kimiCodeFeedbackUrl()).toBe('https://example.test/v9/feedback');
  });
});

describe('fetchSubmitFeedback', () => {
  it('POSTs JSON body with bearer auth and returns ok on 200', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
    );

    expect(result).toEqual({ kind: 'ok' });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [calledUrl, init] = calls[0]!;
    expect(calledUrl).toBe('https://api.example/feedback');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');

    expect(JSON.parse(init?.body as string)).toEqual(SAMPLE_BODY);
  });

  it('preserves the kimi-code- version prefix in the request body', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSubmitFeedback('https://api.example/feedback', 'tok', SAMPLE_BODY);

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const sent = JSON.parse(calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(sent['version']).toBe('kimi-code-0.1.1');
  });

  it('returns an error with status when the server responds 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/401/);
  });

  it('surfaces API error messages from failed submissions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'feedback rejected' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(400);
    expect(result.message).toBe('feedback rejected');
  });

  it('returns an error with status when the server responds 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(500);
    expect(result.message).toBe('Failed to submit feedback: HTTP 500');
  });

  it('returns a timeout error when the request aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
      { timeoutMs: 5 },
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBeUndefined();
    expect(result.message).toMatch(/timed out/);
  });

  it('returns a generic error message on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      'access-token',
      SAMPLE_BODY,
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBeUndefined();
    expect(result.message).toMatch(/network down/);
  });
});
