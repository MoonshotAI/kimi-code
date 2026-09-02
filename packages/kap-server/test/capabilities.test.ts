import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  capabilityStatusSchema,
  listCapabilitiesResponseSchema,
} from '../src/protocol/rest-capability';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1 capabilities', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-capabilities-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
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

  async function postJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: '{}',
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists no capabilities while official entries are hidden from listings', async () => {
    const { body } = await getJson<unknown>('/api/v1/capabilities');
    expect(body.code).toBe(0);
    const parsed = listCapabilitiesResponseSchema.parse(body.data);
    // Official capabilities are temporarily hidden from listings; per-entry
    // get/install keep working for already-installed users.
    expect(parsed.capabilities).toEqual([]);
  });

  it('gets a single capability and 40418s on an unknown id', async () => {
    const { body } = await getJson<unknown>('/api/v1/capabilities/kimi-webbridge');
    expect(body.code).toBe(0);
    expect(capabilityStatusSchema.parse(body.data).id).toBe('kimi-webbridge');

    const missing = await getJson<unknown>('/api/v1/capabilities/nope');
    expect(missing.body.code).toBe(40418);
    expect(missing.body.data).toBeNull();
  });

  it('installs 40418 on an unknown id without side effects', async () => {
    const { body } = await postJson<unknown>('/api/v1/capabilities/nope:install');
    expect(body.code).toBe(40418);
  });

  it('rejects bare ids and unknown actions with 40001', async () => {
    const bare = await postJson<unknown>('/api/v1/capabilities/kimi-cu');
    expect(bare.body.code).toBe(40001);
    const bogus = await postJson<unknown>('/api/v1/capabilities/kimi-cu:uninstall');
    expect(bogus.body.code).toBe(40001);
  });

  it.skipIf(process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64'))(
    'rejects kimi-cu install on unsupported platforms with 40925',
    async () => {
      const { body } = await postJson<unknown>('/api/v1/capabilities/kimi-cu:install');
      expect(body.code).toBe(40925);
    },
  );
});
