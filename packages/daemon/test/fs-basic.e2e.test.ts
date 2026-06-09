/**
 * `/api/v1/sessions/{sid}/fs:list` + `/api/v1/sessions/{sid}/fs:read` end-to-end
 * tests (W10.1 / Chain 9 / P1.9).
 *
 * AC coverage (ROADMAP §Chain 9):
 *   1. list in cwd → entries
 *   2. read normal file
 *   3. path contains `..` / absolute → 41304
 *   4. read 6 MB file under 10 MB cap → ok
 *      read > 10 MB file → 41302
 *   5. read binary file (containing null bytes) → 40907 (utf-8) /
 *      base64 fallback (auto)
 *   6. .gitignore: node_modules is filtered out by default
 *   7. session unknown → 40401
 *   8. unsupported action (fs:bogus) → 40001
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

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-fs-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-fs-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{
        statusCode: number;
        json: () => unknown;
      }>;
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

async function createSession(r: RunningDaemon): Promise<string> {
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

describe('POST /api/v1/sessions/{sid}/fs:list (W10.1)', () => {
  it('lists direct children of cwd', async () => {
    writeFileSync(join(workspace, 'hello.txt'), 'hi');
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'index.ts'), 'export {}');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:list`,
      payload: { path: '.' },
    });
    const env = envelopeOf<{
      items: { name: string; kind: string }[];
      truncated: boolean;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();
    const names = env.data!.items.map((i) => i.name).sort();
    expect(names).toEqual(['hello.txt', 'src']);
    expect(env.data!.truncated).toBe(false);
  });

  it('rejects absolute path with 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:list`,
      payload: { path: '/etc' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(41304);
  });

  it('rejects ".." escape with 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:list`,
      payload: { path: '../..' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(41304);
  });

  it('filters .gitignore-listed paths by default (node_modules)', async () => {
    writeFileSync(join(workspace, '.gitignore'), 'node_modules\n');
    mkdirSync(join(workspace, 'node_modules'));
    writeFileSync(join(workspace, 'node_modules', 'pkg.js'), 'x');
    writeFileSync(join(workspace, 'visible.txt'), 'v');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:list`,
      payload: { path: '.' },
    });
    const env = envelopeOf<{ items: { name: string }[] }>(res.json());
    const names = env.data!.items.map((i) => i.name);
    expect(names).toContain('visible.txt');
    expect(names).not.toContain('node_modules');
  });

  it('honors follow_gitignore=false to include gitignored entries', async () => {
    writeFileSync(join(workspace, '.gitignore'), 'node_modules\n');
    mkdirSync(join(workspace, 'node_modules'));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:list`,
      payload: { path: '.', follow_gitignore: false },
    });
    const env = envelopeOf<{ items: { name: string }[] }>(res.json());
    const names = env.data!.items.map((i) => i.name);
    expect(names).toContain('node_modules');
  });

  it('returns 40401 for unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/does-not-exist/fs:list',
      payload: { path: '.' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('returns 40001 for unsupported action fs:bogus', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:bogus`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('POST /api/v1/sessions/{sid}/fs:read (W10.1)', () => {
  it('reads a normal utf-8 text file', async () => {
    writeFileSync(join(workspace, 'hello.txt'), 'hello world');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'hello.txt' },
    });
    const env = envelopeOf<{
      content: string;
      encoding: 'utf-8' | 'base64';
      is_binary: boolean;
      size: number;
      mime: string;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();
    expect(env.data!.content).toBe('hello world');
    expect(env.data!.encoding).toBe('utf-8');
    expect(env.data!.is_binary).toBe(false);
    expect(env.data!.size).toBe(11);
  });

  it('rejects absolute path with 41304', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: '/etc/passwd' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(41304);
  });

  it('returns 40409 for a missing file', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'no-such-file.txt' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40409);
  });

  it('returns 40906 when path is a directory', async () => {
    mkdirSync(join(workspace, 'a-dir'));
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'a-dir' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40906);
  });

  it('returns 41302 when file size > 10 MB', async () => {
    // 10 MB + 1 byte: exactly trips the > 10 MB check.
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    writeFileSync(join(workspace, 'huge.txt'), huge);
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'huge.txt' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(41302);
  });

  it('returns 40907 for binary file when encoding is utf-8', async () => {
    // 32 bytes of \x00 \x01 \x02 ... — null byte trips the heuristic.
    const bin = Buffer.from([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    ]);
    writeFileSync(join(workspace, 'bin'), bin);
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'bin', encoding: 'utf-8' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40907);
  });

  it('falls back to base64 for binary file when encoding is auto', async () => {
    const bin = Buffer.from([0, 1, 2, 3, 0xfe, 0xff]);
    writeFileSync(join(workspace, 'bin'), bin);
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'bin' },
    });
    const env = envelopeOf<{
      content: string;
      encoding: 'utf-8' | 'base64';
      is_binary: boolean;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.encoding).toBe('base64');
    expect(env.data!.is_binary).toBe(true);
    // base64 round-trips back to the original bytes.
    expect(Buffer.from(env.data!.content, 'base64').equals(bin)).toBe(true);
  });

  it('rejects 11 MB length request via Zod (>10 MB cap)', async () => {
    writeFileSync(join(workspace, 'small.txt'), 'x');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:read`,
      payload: { path: 'small.txt', length: 11 * 1024 * 1024 },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});
