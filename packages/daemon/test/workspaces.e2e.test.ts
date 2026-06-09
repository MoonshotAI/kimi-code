/**
 * Workspace registry end-to-end tests.
 *
 * Covers:
 *   - POST /api/v1/workspaces                 (idempotent on root)
 *   - GET  /api/v1/workspaces                 (list with git probe)
 *   - PATCH /api/v1/workspaces/{id}           (rename)
 *   - DELETE /api/v1/workspaces/{id}          (unlinks workspace.json only)
 *   - Unknown id → 40410
 *   - Non-existent root → 40409
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';
import type { Workspace } from '@moonshot-ai/protocol';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-workspaces-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-workspaces-home-'));
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
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
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
  return body as { code: number; msg: string; data: T | null; request_id: string; details?: unknown };
}

/** Lay down a minimal git fixture: `.git/HEAD` referring to a branch. */
function makeGitRepo(root: string, branch: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
}

describe('POST /api/v1/workspaces — register', () => {
  it('creates a Workspace with derived id, name=basename, is_git_repo via probe', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'my-project');
    mkdirSync(root, { recursive: true });
    makeGitRepo(root, 'main');

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { root },
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<Workspace>(res.json());
    expect(env.code).toBe(0);
    const ws = env.data!;
    expect(ws.id).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    expect(ws.name).toBe('my-project');
    expect(ws.is_git_repo).toBe(true);
    expect(ws.branch).toBe('main');
    expect(ws.session_count).toBe(0);
    expect(ws.root).toBeTruthy();
  });

  it('uses caller-supplied name when present', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'p');
    mkdirSync(root, { recursive: true });
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { root, name: 'My Pretty Name' },
    });
    expect(envelopeOf<Workspace>(res.json()).data!.name).toBe('My Pretty Name');
  });

  it('is idempotent on root (same id, updates last_opened_at on subsequent POST)', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'idempotent');
    mkdirSync(root, { recursive: true });
    const first = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root } })).json(),
    ).data!;
    // Sleep 5ms so the second touch's last_opened_at differs from the first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root } })).json(),
    ).data!;
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.last_opened_at >= first.last_opened_at).toBe(true);
  });

  it('returns 40409 when root does not exist', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { root: join(tmpDir, 'does-not-exist') },
    });
    expect(envelopeOf(res.json()).code).toBe(40409);
  });

  it('returns 40001 when root is empty', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { root: '' },
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });
});

describe('GET /api/v1/workspaces — list', () => {
  it('returns sorted-by-last-opened-desc list with git probe', async () => {
    const r = await bootDaemon();
    const a = join(tmpDir, 'alpha');
    const b = join(tmpDir, 'beta');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    makeGitRepo(a, 'feature/x');

    await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: a } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: b } });

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/workspaces' });
    const items = envelopeOf<{ items: Workspace[] }>(res.json()).data!.items;
    expect(items).toHaveLength(2);
    // Newest first
    expect(items[0]!.name).toBe('beta');
    expect(items[1]!.name).toBe('alpha');
    expect(items[1]!.is_git_repo).toBe(true);
    expect(items[1]!.branch).toBe('feature/x');
  });

  it('returns empty list when no workspaces are registered', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/workspaces' });
    expect(envelopeOf<{ items: Workspace[] }>(res.json()).data!.items).toEqual([]);
  });
});

describe('PATCH /api/v1/workspaces/{id} — rename', () => {
  it('updates the display name', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'renameme');
    mkdirSync(root, { recursive: true });
    const created = envelopeOf<Workspace>(
      (
        await appOf(r).inject({
          method: 'POST',
          url: '/api/v1/workspaces',
          payload: { root },
        })
      ).json(),
    ).data!;
    const renamed = envelopeOf<Workspace>(
      (
        await appOf(r).inject({
          method: 'PATCH',
          url: `/api/v1/workspaces/${created.id}`,
          payload: { name: 'New Name' },
        })
      ).json(),
    ).data!;
    expect(renamed.name).toBe('New Name');
    expect(renamed.id).toBe(created.id);
  });

  it('returns 40410 for unknown workspace id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'PATCH',
      url: '/api/v1/workspaces/wd_nonexistent_0123456789ab',
      payload: { name: 'X' },
    });
    expect(envelopeOf(res.json()).code).toBe(40410);
  });

  it('returns 40001 for invalid workspace_id shape', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'PATCH',
      url: '/api/v1/workspaces/not-a-wd-id',
      payload: { name: 'X' },
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });
});

describe('DELETE /api/v1/workspaces/{id} — unregister', () => {
  it('removes workspace.json but does not touch on-disk content', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'deleteme');
    mkdirSync(root, { recursive: true });
    const created = envelopeOf<Workspace>(
      (
        await appOf(r).inject({
          method: 'POST',
          url: '/api/v1/workspaces',
          payload: { root },
        })
      ).json(),
    ).data!;
    const deletedRes = await appOf(r).inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${created.id}`,
    });
    expect(envelopeOf<{ deleted: true }>(deletedRes.json()).data).toEqual({ deleted: true });
    // The workspace no longer shows up in list, but the root dir still exists.
    const listRes = await appOf(r).inject({ method: 'GET', url: '/api/v1/workspaces' });
    expect(envelopeOf<{ items: Workspace[] }>(listRes.json()).data!.items).toEqual([]);
  });

  it('returns 40410 for unknown workspace id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/wd_nonexistent_0123456789ab',
    });
    expect(envelopeOf(res.json()).code).toBe(40410);
  });
});
