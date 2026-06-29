/**
 * `/api/v1/fs:browse` + `/api/v1/fs:home` end-to-end tests.
 *
 * Covers:
 *   - GET /fs:home              → { home, recent_roots }
 *   - GET /fs:browse?path=$tmp  → lists child dirs + git probe
 *   - relative path             → 40001
 *   - missing path              → 40409
 *   - permission denied         → 40411 (skipped when running as root)
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import type {
  FsBrowseEntry,
  FsBrowseResponse,
  FsHomeResponse,
  Workspace,
} from '@moonshot-ai/protocol';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-fsbrowse-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-fsbrowse-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  // Re-chmod anything we made unreadable so rmSync can clean it.
  try {
    chmodSync(join(tmpDir, 'locked'), 0o700);
  } catch {
    // ignore — fixture may not exist
  }
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

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as { code: number; msg: string; data: T | null; request_id: string; details?: unknown };
}

function makeGitRepo(root: string, branch: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
}

describe('GET /api/v1/fs:home', () => {
  it('returns the user $HOME directory + empty recent_roots when nothing is registered', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/fs:home' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<FsHomeResponse>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.home).toBe(os.homedir());
    expect(env.data!.recent_roots).toEqual([]);
  });

  it('populates recent_roots from registered workspaces (newest first)', async () => {
    const r = await bootDaemon();
    const a = join(tmpDir, 'first');
    const b = join(tmpDir, 'second');
    mkdirSync(a);
    mkdirSync(b);
    await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: a } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: b } });

    const env = envelopeOf<FsHomeResponse>(
      (await appOf(r).inject({ method: 'GET', url: '/api/v1/fs:home' })).json(),
    );
    expect(env.data!.recent_roots.length).toBe(2);
    // Sourced from workspaces sorted by last_opened_at desc → newest first.
    expect(env.data!.recent_roots[0]).toContain('second');
    expect(env.data!.recent_roots[1]).toContain('first');
  });
});

describe('GET /api/v1/fs:browse', () => {
  it('lists immediate subdirectories with git probe (only dirs, not files)', async () => {
    const r = await bootDaemon();
    mkdirSync(join(tmpDir, 'alpha'));
    mkdirSync(join(tmpDir, 'beta'));
    makeGitRepo(join(tmpDir, 'beta'), 'develop');
    writeFileSync(join(tmpDir, 'README.md'), 'no', 'utf8'); // file, must not be listed
    mkdirSync(join(tmpDir, '.hidden'));

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/fs:browse?path=${encodeURIComponent(tmpDir)}`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<FsBrowseResponse>(res.json());
    expect(env.code).toBe(0);
    const names = env.data!.entries.map((e) => e.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('.hidden');
    expect(names).not.toContain('README.md');
    // Sort: non-dot first (alpha, beta) then dot (.hidden) last.
    expect(names[names.length - 1]).toBe('.hidden');
    // Git probe on beta returned the branch.
    const beta = env.data!.entries.find((e): e is FsBrowseEntry => e.name === 'beta')!;
    expect(beta.is_git_repo).toBe(true);
    expect(beta.branch).toBe('develop');
    // Parent is set (not null).
    expect(env.data!.parent).toBeTruthy();
  });

  it('returns 40001 when path is relative', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/fs:browse?path=relative%2Fpath',
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('returns 40409 when path does not exist', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/fs:browse?path=${encodeURIComponent(join(tmpDir, 'does-not-exist'))}`,
    });
    expect(envelopeOf(res.json()).code).toBe(40409);
  });

  it.skipIf(process.platform === 'win32')('returns 40411 when path is unreadable (chmod 000)', async () => {
    if (process.getuid?.() === 0) {
      // Root bypasses permission checks; skip.
      return;
    }
    const r = await bootDaemon();
    const locked = join(tmpDir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const res = await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/fs:browse?path=${encodeURIComponent(locked)}`,
      });
      expect(envelopeOf(res.json()).code).toBe(40411);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('defaults to $HOME when path query is omitted', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/fs:browse' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<FsBrowseResponse>(res.json());
    expect(env.code).toBe(0);
    // realpath of $HOME on macOS may differ from os.homedir() (e.g. /Users vs
    // /System/Volumes/Data/Users), and on Windows it is a drive path. Just
    // sanity-check the response has an absolute path.
    expect(isAbsolute(env.data!.path)).toBe(true);
  });
});

// Silence unused-Workspace import (kept for ts inference in future expansion).
void ({} as Workspace | undefined);
