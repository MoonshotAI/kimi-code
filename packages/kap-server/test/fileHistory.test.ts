import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string;
let server: RunningServer | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-file-history-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
  return server;
}

interface InjectResponse {
  statusCode: number;
  body: string;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
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

interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: home } },
    headers: { 'content-type': 'application/json' },
  });
  const envelope = res.json() as Envelope<{ id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`failed to create session: ${res.body}`);
  }
  return envelope.data.id;
}

describe('file history routes', () => {
  it('serves empty changes and null content for a live session without history', async () => {
    const r = await boot();
    const sessionId = await createSession(r);

    const changes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_id=1`,
    });
    expect(changes.statusCode).toBe(200);
    expect((changes.json() as Envelope<{ changes: unknown[] }>).data).toEqual({
      changes: [],
      enabled: false,
      recorded: false,
    });

    const content = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/content?turn_id=1&path=a.txt`,
    });
    expect(content.statusCode).toBe(200);
    expect((content.json() as Envelope<{ content: unknown }>).data).toEqual({ content: null });
  });

  it('rejects a session that is not live', async () => {
    const r = await boot();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/file-history/changes?turn_id=1',
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
    expect(envelope.data).toBeNull();
  });

  it('rejects a malformed turn_id', async () => {
    const r = await boot();
    const sessionId = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_id=abc`,
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
  });
});
