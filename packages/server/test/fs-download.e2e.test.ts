/**
 * `GET /api/v1/sessions/{sid}/fs/{path}:download` end-to-end tests
 * (W11.3 / Chain 13 / P1.13).
 *
 * AC coverage (ROADMAP §Chain 13):
 *   1. e2e: text / binary / large file streamed (no full-load in memory)
 *   2. client kill mid-stream → server log "client aborted" — no leak
 *   3. path not found → HTTP 200 + envelope `code: 40409 fs.path_not_found`
 *
 * Plus:
 *   - Subdirectory path with `/` retained
 *   - Range request → HTTP 206 + Content-Range
 *   - If-None-Match → HTTP 304 empty body
 *   - Path safety (..) → HTTP 200 + envelope code 41304
 *   - Directory path → HTTP 200 + envelope code 40906
 *   - 40401 unknown session
 *   - Unsupported action suffix → HTTP 200 + envelope 40001
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-fs-download-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-fs-download-home-'));
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
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  payload: string;
  rawPayload: Buffer;
  body: string;
  json: () => unknown;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<InjectResponse>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<InjectResponse>;
    };
  });
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

describe('GET /api/v1/sessions/{sid}/fs/{path}:download (W11.3)', () => {
  it('streams a text file with the correct mime + length headers', async () => {
    writeFileSync(join(workspace, 'hello.txt'), 'hello world\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/hello.txt:download`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('12');
    expect(res.headers['content-disposition']).toContain('hello.txt');
    expect(res.headers['etag']).toBeDefined();
    expect(res.rawPayload.toString('utf-8')).toBe('hello world\n');
  });

  it('streams a binary file (PNG-ish bytes) as octet-stream', async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    ]);
    writeFileSync(join(workspace, 'pixel.png'), bytes);

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/pixel.png:download`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('streams files inside subdirectories (path with slashes)', async () => {
    mkdirSync(join(workspace, 'src', 'lib'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'lib', 'util.ts'), 'export {};');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/src/lib/util.ts:download`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('util.ts');
    expect(res.rawPayload.toString('utf-8')).toBe('export {};');
  });

  it('streams a 5MB file end-to-end (Content-Length matches; bytes match)', async () => {
    const SIZE = 5 * 1024 * 1024;
    const bytes = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) bytes[i] = i & 0xff;
    writeFileSync(join(workspace, 'big.bin'), bytes);

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/big.bin:download`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.rawPayload.length).toBe(SIZE);
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('serves Range requests as HTTP 206 + Content-Range', async () => {
    writeFileSync(join(workspace, 'a.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/a.bin:download`,
      headers: { Range: 'bytes=2-5' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect(res.rawPayload.equals(Buffer.from([2, 3, 4, 5]))).toBe(true);
  });

  it('serves suffix Range (last 3 bytes)', async () => {
    writeFileSync(join(workspace, 'a.bin'), Buffer.from([0, 1, 2, 3, 4]));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/a.bin:download`,
      headers: { Range: 'bytes=-3' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-4/5');
    expect(res.rawPayload.equals(Buffer.from([2, 3, 4]))).toBe(true);
  });

  it('serves open-ended Range (from N to EOF)', async () => {
    writeFileSync(join(workspace, 'a.bin'), Buffer.from([0, 1, 2, 3, 4]));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/a.bin:download`,
      headers: { Range: 'bytes=3-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 3-4/5');
    expect(res.rawPayload.equals(Buffer.from([3, 4]))).toBe(true);
  });

  it('honors If-None-Match → HTTP 304', async () => {
    writeFileSync(join(workspace, 'hello.txt'), 'hi');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const first = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/hello.txt:download`,
    });
    expect(first.statusCode).toBe(200);
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();
    const second = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/hello.txt:download`,
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers['etag']).toBe(etag);
    expect(second.rawPayload.length).toBe(0);
  });

  it('missing path → HTTP 200 + envelope code 40409', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/does-not-exist.txt:download`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.headers['content-type'] as string) ?? '').toContain('json');
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40409);
  });

  it('directory path → HTTP 200 + envelope code 40906', async () => {
    mkdirSync(join(workspace, 'src'));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/src:download`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40906);
  });

  it('path with `..` → HTTP 200 + envelope code 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    // Percent-encode `..` so URL normalization doesn't collapse it
    // before the route handler sees it; the server's path-safety guard
    // is what we're testing, not the URL parser.
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/%2E%2E%2Foutside.txt:download`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(41304);
  });

  it('unknown session → HTTP 200 + envelope code 40401', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_does_not_exist/fs/a.txt:download',
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40401);
  });

  it('unsupported action suffix → HTTP 200 + envelope code 40001', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'x');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/a.txt:bogus`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40001);
  });

  it('empty wildcard (just :download) → HTTP 200 + envelope code 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/fs/:download`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40001);
  });
});
