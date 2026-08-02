import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { z } from 'zod';

import { managedUsageResultSchema } from '../src/protocol/rest-oauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

type ManagedUsageResult = z.infer<typeof managedUsageResultSchema>;

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/oauth/usage', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-oauth-usage-'));
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
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('answers the unmanaged wire error shape on the native engine', async () => {
    const res = await fetch(`${base}/api/v1/oauth/usage`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ManagedUsageResult>;
    expect(body.code).toBe(0);
    // Managed OAuth was a v2 `IOAuthService` capability retired with the v2
    // engine — the route answers the error wire shape so the UI shows an
    // unmanaged state instead of hanging.
    expect(managedUsageResultSchema.parse(body.data)).toEqual({
      kind: 'error',
      message: 'managed account usage is not available on the native engine',
      status: 404,
    });
  });
});
