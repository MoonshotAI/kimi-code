/**
 * `/api/v1/meta` end-to-end smoke (W6.1 / Chain 1 / P1.1).
 *
 * Boots the real server (hermetic — port 0, tmp lock + bridge home), hits
 * `GET /api/v1/meta` via Fastify's `inject` simulator on the constructed app, and
 * asserts:
 *   1. Envelope shape (`code: 0`, `msg: success`, `request_id`, `data`).
 *   2. `data` matches `metaResponseSchema` — server_version + capabilities
 *      literals + server_id ULID + started_at ISO `Z`.
 *   3. `server_id` is stable across multiple calls to the same server
 *      (it's process-scoped, not per-request).
 *   4. `started_at` is the server's boot time — within a generous window of
 *      `Date.now()` at test start.
 *
 * Plus request_id propagation (already covered for `/api/v1/healthz` in
 * `error-handler.test.ts` but re-asserted here because the prompt requires
 * Chain 1's first business endpoint to demonstrate the W4.3 request_id pipe):
 *
 *   - Valid ULID `X-Request-Id` → echoed verbatim.
 *   - No header → bare ULID minted (`ulidRegex`).
 *   - Malformed header → fresh bare ULID (NOT `req_garbage`).
 *
 * The server's bridge `homeDir` is sandboxed so the test doesn't touch the
 * user's `~/.kimi`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { metaResponseSchema, ulidRegex } from '@moonshot-ai/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;
const bootBaseline = Date.now();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-meta-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-meta-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

/**
 * Pull the Fastify instance off the running server via the IRestGateway
 * accessor — Fastify exposes `.inject()` so we don't need a port.
 */
function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
}

describe('GET /api/v1/meta — envelope + metaResponseSchema', () => {
  it('responds 200 with code 0 + schema-conforming data', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(0);
    expect(body['msg']).toBe('success');
    expect(typeof body['request_id']).toBe('string');
    expect(body['data']).not.toBeNull();

    const data = body['data'];
    const parsed = metaResponseSchema.parse(data);

    expect(parsed.server_version.length).toBeGreaterThan(0);
    expect(parsed.capabilities).toEqual({
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      background_tasks: true,
      terminal: true,
    });
    expect(ulidRegex.test(parsed.server_id)).toBe(true);
    // started_at is ISO 8601 UTC `Z` per isoDateTimeSchema's normalization.
    expect(parsed.started_at).toMatch(/Z$/);
    const startedMs = Date.parse(parsed.started_at);
    expect(Number.isFinite(startedMs)).toBe(true);
    // Should fall within [bootBaseline-1s, now+1s] — generous slack.
    expect(startedMs).toBeGreaterThanOrEqual(bootBaseline - 1_000);
    expect(startedMs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('server_id is stable across multiple calls (process-scoped)', async () => {
    const r = await bootDaemon();
    const app = appOf(r);
    const a = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    const b = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    const aData = (a.json() as { data: { server_id: string } }).data;
    const bData = (b.json() as { data: { server_id: string } }).data;
    expect(aData.server_id).toBe(bData.server_id);
  });

  it('two independent daemons get distinct daemon_ids', async () => {
    // Use distinct lock paths so both can coexist for the duration of the test.
    const lockA = join(tmpDir, 'lock-a');
    const lockB = join(tmpDir, 'lock-b');
    const homeA = mkdtempSync(join(tmpdir(), 'kimi-server-meta-home-a-'));
    const homeB = mkdtempSync(join(tmpdir(), 'kimi-server-meta-home-b-'));
    const r1 = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath: lockA,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir: homeA },
    });
    const r2 = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath: lockB,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir: homeB },
    });
    try {
      const a = await appOf(r1).inject({ method: 'GET', url: '/api/v1/meta' });
      const b = await appOf(r2).inject({ method: 'GET', url: '/api/v1/meta' });
      const aData = (a.json() as { data: { server_id: string } }).data;
      const bData = (b.json() as { data: { server_id: string } }).data;
      expect(aData.server_id).not.toBe(bData.server_id);
    } finally {
      await r1.close();
      await r2.close();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});

describe('GET /api/v1/meta — server_version precedence', () => {
  it('reports the host kimi-code identity version when provided', async () => {
    server = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: {
        homeDir: bridgeHome,
        identity: { userAgentProduct: 'kimi-code-cli', version: '9.9.9-test' },
      },
    });
    const res = await appOf(server).inject({ method: 'GET', url: '/api/v1/meta' });
    const data = (res.json() as { data: { server_version: string } }).data;
    expect(data.server_version).toBe('9.9.9-test');
  });
});

describe('GET /api/v1/meta — request_id propagation (W4.3 contract)', () => {
  it('echoes a client-supplied valid ULID verbatim', async () => {
    const r = await bootDaemon();
    const goodUlid = '01HQXY4Z2M3GZP6F8K9R5W7VBA';
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { 'x-request-id': goodUlid },
    });
    const body = res.json() as Record<string, unknown>;
    expect(body['request_id']).toBe(goodUlid);
  });

  it('mints a bare ULID when no header is supplied (no req_ prefix)', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/meta' });
    const body = res.json() as Record<string, unknown>;
    const id = body['request_id'] as string;
    expect(id).not.toMatch(/^req_/);
    expect(ulidRegex.test(id)).toBe(true);
  });

  it('discards malformed X-Request-Id and mints a fresh ULID', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { 'x-request-id': 'req_garbage' },
    });
    const body = res.json() as Record<string, unknown>;
    const id = body['request_id'] as string;
    expect(id).not.toBe('req_garbage');
    expect(id).not.toMatch(/^req_/);
    expect(ulidRegex.test(id)).toBe(true);
  });
});
