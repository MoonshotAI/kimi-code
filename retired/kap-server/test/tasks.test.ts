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
  details?: unknown;
}

interface TaskWire {
  id: string;
  session_id: string;
  kind: string;
  description: string;
  status: string;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
}

interface ListWire {
  items: TaskWire[];
}

describe('server-v2 /api/v1/sessions/{sid}/tasks', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tasks-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
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

  it('returns an empty list when the session has no background tasks', async () => {
    const id = await createSession();
    const { body } = await getJson<ListWire>(`/api/v1/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('returns 40401 for an unknown session', async () => {
    const list = await getJson<null>('/api/v1/sessions/nope/tasks');
    expect(list.body.code).toBe(40401);
  });

  // Engine-only note: the engine exposes `task/list` but no task get-by-id /
  // cancel RPC, so the v1 `GET /tasks/{task_id}` and
  // `POST /tasks/{task_id}:cancel` endpoints are not registered in engine
  // mode (they answer Fastify's default 404). Re-add them together with the
  // engine RPC if/when the engine grows a per-task surface.
});
