import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('ARTEX routes', () => {
  let home: string;
  let server: RunningServer;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kap-artex-routes-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
    const base = `http://${server.host}:${server.port}`;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...authHeaders(server), 'content-type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const base = `http://${server.host}:${server.port}`;
    const res = await fetch(`${base}${path}`, { headers: authHeaders(server) });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('returns ARTEX_NOT_ENABLED when the artex flag is off', async () => {
    const created = await postJson<{ id: string }>('/api/v1/sessions', { metadata: { cwd: home } });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const status = await getJson(`/api/v1/sessions/${id}/artex/status`);
    expect(status.body.code).toBe(40936);
    expect(status.body.msg).toContain('ARTEX is not enabled');

    const companies = await getJson(`/api/v1/artex/companies?cwd=${encodeURIComponent(home)}`);
    expect(companies.body.code).toBe(40936);
  });
});