import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface MessageWire {
  id: string;
  session_id: string;
  role: string;
  content: { type: string; [key: string]: unknown }[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface PageWire {
  items: MessageWire[];
  has_more: boolean;
}

describe('server-v2 /api/v1/sessions/{sid}/messages', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-messages-'));
    await boot();
  });

  async function boot(): Promise<void> {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  it('returns an empty page when the session has no main agent', async () => {
    const id = await createSession();
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('returns 40401 for an unknown session', async () => {
    const list = await getJson<null>('/api/v1/sessions/nope/messages');
    expect(list.body.code).toBe(40401);
  });
});
