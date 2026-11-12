import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../../src/start';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';
import { authedFetch } from '../helpers/auth';

interface Envelope<T> {
  code: number;
  data: T;
}

describe('server-v2 removed global search route', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-search-removed-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      env: { ...process.env, KIMI_CODE_GLOBAL_SEARCH: '1' },
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('returns 404 for the old route while health and session routes stay available', async () => {
    const searchRes = await authedFetch(server!, base, '/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything' }),
    });
    expect(searchRes.status).toBe(404);

    const healthRes = await authedFetch(server!, base, '/api/v1/healthz');
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Envelope<{ ok: boolean }>;
    expect(health.code).toBe(0);
    expect(health.data.ok).toBe(true);

    const sessionsRes = await authedFetch(server!, base, '/api/v1/sessions');
    expect(sessionsRes.status).toBe(200);
    const sessions = (await sessionsRes.json()) as Envelope<{ items: unknown[] }>;
    expect(sessions.code).toBe(0);
    expect(Array.isArray(sessions.data.items)).toBe(true);
  });
});
