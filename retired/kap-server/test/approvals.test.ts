/**
 * Engine-mode `/api/v1/sessions/{sid}/approvals`.
 *
 * Engine-only projection: the approval surface rides the engine's
 * `session/approval_list` + `session/approval_resolve` RPC; the v2
 * per-approval `POST /approvals/{approval_id}` endpoint (40404 semantics) was
 * retired with the engine migration.
 */

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

describe('engine-mode /api/v1/sessions/{sid}/approvals', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-approvals-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

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

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    arg?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers = authHeaders(
      server as RunningServer,
      arg === undefined ? {} : { 'content-type': 'application/json' },
    );
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (arg !== undefined) {
      init.body = JSON.stringify(arg);
    }
    const res = await fetch(`${base}${path}`, init as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  it('returns an empty approval list for a fresh session', async () => {
    const id = await createSession();

    const { body } = await call<{ items: unknown[] }>(
      'GET',
      `/api/v1/sessions/${id}/approvals`,
    );
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items).toEqual([]);
  });

  it('rejects a resolve with a missing decision with 40001', async () => {
    const id = await createSession();

    const { body } = await call<null>(
      'POST',
      `/api/v1/sessions/${id}/approvals/resolve`,
      { id: 'ap_does_not_exist' },
    );
    expect(body.code).toBe(40001);
  });

  it('returns 40401 for an unknown session', async () => {
    const list = await call<null>('GET', '/api/v1/sessions/nope/approvals');
    expect(list.body.code).toBe(40401);

    const resolve = await call<null>('POST', '/api/v1/sessions/nope/approvals/resolve', {
      id: 'ap_x',
      decision: 'allow',
    });
    expect(resolve.body.code).toBe(40401);
  });
});
