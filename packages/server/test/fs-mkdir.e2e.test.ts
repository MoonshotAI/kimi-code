/**
 * `/api/v1/sessions/{sid}/fs:mkdir` end-to-end tests.
 *
 * Coverage:
 *   1. create a single directory under cwd → 200 + directory entry
 *   2. recursive create a/b/c → 200
 *   3. target already exists (dir / file, non-recursive) → 40919
 *   4. recursive:true on existing dir → idempotent success
 *   5. parent missing + non-recursive → 40409
 *   6. path with `..` / absolute → 41304
 *   7. unknown session → 40401
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-fs-mkdir-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-fs-mkdir-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
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

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
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

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: workspace } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

describe('POST /api/v1/sessions/{sid}/fs:mkdir', () => {
  it('creates a single directory under cwd', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'newdir' },
    });
    const env = envelopeOf<{
      path: string;
      name: string;
      kind: string;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();
    expect(env.data!.path).toBe('newdir');
    expect(env.data!.name).toBe('newdir');
    expect(env.data!.kind).toBe('directory');
    expect(statSync(join(workspace, 'newdir')).isDirectory()).toBe(true);
  });

  it('creates nested directories with recursive:true', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'a/b/c', recursive: true },
    });
    const env = envelopeOf<{ path: string; kind: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.path).toBe('a/b/c');
    expect(env.data!.kind).toBe('directory');
    expect(statSync(join(workspace, 'a', 'b', 'c')).isDirectory()).toBe(true);
  });

  it('returns 40919 when target directory already exists (non-recursive)', async () => {
    mkdirSync(join(workspace, 'existing'));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'existing' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40919);
  });

  it('returns 40919 when target is an existing file', async () => {
    writeFileSync(join(workspace, 'afile.txt'), 'x');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'afile.txt' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40919);
  });

  it('is idempotent for an existing directory with recursive:true', async () => {
    mkdirSync(join(workspace, 'existing'));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'existing', recursive: true },
    });
    const env = envelopeOf<{ path: string; kind: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.kind).toBe('directory');
  });

  it('returns 40409 when parent is missing (non-recursive)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: 'missing/child' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40409);
    expect(existsSync(join(workspace, 'missing'))).toBe(false);
  });

  it('rejects ".." escape with 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: '../escape' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(41304);
  });

  it('rejects absolute path with 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:mkdir`,
      payload: { path: '/tmp/absolute' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(41304);
  });

  it('returns 40401 for unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/does-not-exist/fs:mkdir',
      payload: { path: 'newdir' },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40401);
  });
});
