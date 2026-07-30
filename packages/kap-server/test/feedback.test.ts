import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IOAuthService } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): Envelope<T> {
  return body as Envelope<T>;
}

function post(api: AppLike, url: string, payload: unknown) {
  return api.inject({ method: 'POST', url, payload });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface BackendCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly body: Record<string, unknown>;
}

function backendCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): BackendCall {
  const call = fetchMock.mock.calls[index] as [string, RequestInit];
  const rawBody = call[1].body;
  if (typeof rawBody !== 'string') {
    throw new TypeError('expected the backend request body to be a JSON string');
  }
  return {
    url: call[0],
    method: call[1].method ?? 'GET',
    authorization: (call[1].headers as Record<string, string>)['Authorization'] ?? '',
    body: JSON.parse(rawBody) as Record<string, unknown>,
  };
}

describe('server-v2 feedback routes', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let loggedIn: boolean;
  let kimiCodeBaseUrl: string | undefined;
  let refreshInterval: string | undefined;
  let refreshOnStart: string | undefined;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    kimiCodeBaseUrl = process.env['KIMI_CODE_BASE_URL'];
    refreshInterval = process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
    refreshOnStart = process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIMI_CODE_BASE_URL'];
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    loggedIn = true;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    const fakeOAuth = {
      status: async () => ({ loggedIn }),
      resolveTokenProvider: () => ({
        getAccessToken: async () => 'test-access-token',
      }),
    } as unknown as IOAuthService;
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-feedback-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://example.test/managed/"',
        '',
      ].join('\n'),
      'utf8',
    );
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IOAuthService, fakeOAuth]],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    restoreEnv('KIMI_CODE_BASE_URL', kimiCodeBaseUrl);
    restoreEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', refreshInterval);
    restoreEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', refreshOnStart);
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('forwards feedback to the managed backend and returns feedback_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ feedback_id: 7 }));
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'the session list flashes on open',
      session_id: 's-1',
      type: 'bug',
      title: 'session list flashes',
      contact: 'user@example.com',
      diagnostics: 'logs',
      agent_id: 'a-1',
      info: { surface: 'settings' },
    });

    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ feedback_id: number }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.feedback_id).toBe(7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = backendCall(fetchMock);
    expect(call.url).toBe('https://example.test/managed/feedback');
    expect(call.method).toBe('POST');
    expect(call.authorization).toBe('Bearer test-access-token');
    expect(call.body).toMatchObject({
      session_id: 's-1',
      content: 'the session list flashes on open',
      contact: 'user@example.com',
      model: null,
      info: {
        type: 'bug',
        title: 'session list flashes',
        diagnostics: 'logs',
        agent_id: 'a-1',
        surface: 'settings',
      },
    });
    expect(String(call.body['version'])).toMatch(/^kimi-code-/);
    expect(typeof call.body['os']).toBe('string');
    expect(String(call.body['os']).length).toBeGreaterThan(0);
  });

  it('omits info when no detail fields are present', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ feedback_id: 8 }));
    await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'quick note',
      session_id: 's-1',
    });

    const call = backendCall(fetchMock);
    expect('info' in call.body).toBe(false);
    expect('contact' in call.body).toBe(false);
  });

  it('rejects reserved info keys before forwarding feedback', async () => {
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'the session list flashes on open',
      session_id: 's-1',
      type: 'bug',
      info: { type: 'feature' },
    });

    expect(envelopeOf(res.json()).code).toBe(40001);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 40111 when not signed in and never calls the backend', async () => {
    loggedIn = false;
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'hello',
      session_id: 's-1',
    });

    expect(envelopeOf(res.json()).code).toBe(40111);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a backend failure to 50001', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'hello',
      session_id: 's-1',
    });

    expect(envelopeOf(res.json()).code).toBe(50001);
  });

  it('proxies upload_url to the backend', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        upload: {
          id: 3,
          parts: [{ part_number: 1, url: 'https://example.com/upload-part-1', method: 'PUT', size: 64 }],
        },
      }),
    );
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback/upload_url', {
      feedback_id: 7,
      file_name: 'session.zip',
      file_size: 64,
      file_hash: 'deadbeef',
    });

    const env = envelopeOf<{ upload_id: number; parts: unknown[] }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.upload_id).toBe(3);
    expect(env.data?.parts).toEqual([
      { part_number: 1, url: 'https://example.com/upload-part-1', method: 'PUT', size: 64 },
    ]);

    const call = backendCall(fetchMock);
    expect(call.url).toBe('https://example.test/managed/feedback/upload_url');
    expect(call.authorization).toBe('Bearer test-access-token');
    expect(call.body).toMatchObject({
      feedback_id: 7,
      file_name: 'session.zip',
      file_size: 64,
      file_hash: 'deadbeef',
    });
  });

  it('proxies upload_complete to the backend', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback/upload_complete', {
      upload_id: 3,
      parts: [{ part_number: 1, etag: 'etag-1' }],
    });

    expect(envelopeOf<null>(res.json()).code).toBe(0);
    const call = backendCall(fetchMock);
    expect(call.url).toBe('https://example.test/managed/feedback/upload_complete');
    expect(call.authorization).toBe('Bearer test-access-token');
    expect(call.body).toMatchObject({
      upload_id: 3,
      parts: [{ part_number: 1, etag: 'etag-1' }],
    });
  });

  it('rejects a missing content', async () => {
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      session_id: 's-1',
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('rejects a missing session_id', async () => {
    const res = await post(appOf(server as RunningServer), '/api/v1/feedback', {
      content: 'hello',
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
