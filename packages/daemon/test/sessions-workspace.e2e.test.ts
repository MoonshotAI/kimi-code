/**
 * `POST /api/v1/sessions { workspace_id }` + `GET /api/v1/sessions?workspace_id=` tests.
 *
 * Covers:
 *   - POST { workspace_id } → derives metadata.cwd from workspace.root
 *   - Session response carries `workspace_id` derived from encodeWorkDirKey
 *   - GET ?workspace_id= filters via the readdir fast path
 *   - Legacy POST { metadata: { cwd } } still works AND `workspace_id` is set
 *   - Legacy session retroactively grouped after `POST /workspaces { root }`
 *   - workspace_id mismatch on POST → 40001
 *   - Unknown workspace_id → 40410 (on POST and GET)
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';
import type { Session, Workspace } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-swsessions-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-swsessions-home-'));
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

describe('POST /api/v1/sessions with workspace_id', () => {
  it('resolves workspace_id → workspace.root → metadata.cwd and stamps workspace_id', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'project-a');
    mkdirSync(root, { recursive: true });
    const ws = envelopeOf<Workspace>(
      (
        await appOf(r).inject({
          method: 'POST',
          url: '/api/v1/workspaces',
          payload: { root },
        })
      ).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspace_id: ws.id },
    });
    expect(res.statusCode).toBe(200);
    const session = envelopeOf<Session>(res.json()).data!;
    expect(session.workspace_id).toBe(ws.id);
    expect(session.metadata.cwd).toBe(ws.root);
  });

  it('legacy `metadata.cwd` only still works and the response includes a derived workspace_id', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'project-b');
    mkdirSync(cwd, { recursive: true });
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd } },
    });
    const session = envelopeOf<Session>(res.json()).data!;
    expect(session.metadata.cwd).toBe(cwd);
    expect(session.workspace_id).toBe(encodeWorkDirKey(cwd));
  });

  it('returns 40001 when both workspace_id AND metadata.cwd are sent but disagree', async () => {
    const r = await bootDaemon();
    const root = join(tmpDir, 'project-c');
    mkdirSync(root, { recursive: true });
    const ws = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root } })).json(),
    ).data!;

    const otherCwd = join(tmpDir, 'unrelated-cwd');
    mkdirSync(otherCwd, { recursive: true });
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspace_id: ws.id, metadata: { cwd: otherCwd } },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40001);
  });

  it('returns 40001 when neither workspace_id nor metadata.cwd is set', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { title: 'neither field' },
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('returns 40410 for unknown workspace_id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspace_id: 'wd_nonexistent_0123456789ab' },
    });
    expect(envelopeOf(res.json()).code).toBe(40410);
  });
});

describe('GET /api/v1/sessions?workspace_id= — fast path', () => {
  it('returns only sessions whose cwd matches the workspace.root', async () => {
    const r = await bootDaemon();
    const a = join(tmpDir, 'A');
    const b = join(tmpDir, 'B');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const wsA = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: a } })).json(),
    ).data!;
    const wsB = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: b } })).json(),
    ).data!;

    // 2 in A, 1 in B
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { workspace_id: wsA.id } });
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { workspace_id: wsA.id } });
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { workspace_id: wsB.id } });

    const pageA = envelopeOf<{ items: Session[]; has_more: boolean }>(
      (await appOf(r).inject({ method: 'GET', url: `/api/v1/sessions?workspace_id=${wsA.id}` })).json(),
    ).data!;
    expect(pageA.items).toHaveLength(2);
    expect(pageA.items.every((s) => s.workspace_id === wsA.id)).toBe(true);

    const pageB = envelopeOf<{ items: Session[]; has_more: boolean }>(
      (await appOf(r).inject({ method: 'GET', url: `/api/v1/sessions?workspace_id=${wsB.id}` })).json(),
    ).data!;
    expect(pageB.items).toHaveLength(1);
    expect(pageB.items[0]!.workspace_id).toBe(wsB.id);
  });

  it('returns 40410 for unknown workspace_id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions?workspace_id=wd_nonexistent_0123456789ab',
    });
    expect(envelopeOf(res.json()).code).toBe(40410);
  });

  it('returns 40001 for malformed workspace_id query value', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions?workspace_id=not-a-wd-id',
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });
});

describe('Legacy sessions retroactively grouped after POST /workspaces', () => {
  it('a session created via legacy metadata.cwd appears in `?workspace_id=` once that root is registered', async () => {
    const r = await bootDaemon();
    const dir = join(tmpDir, 'legacy');
    mkdirSync(dir, { recursive: true });
    // macOS `/tmp` is a symlink to `/private/tmp`; agent-core normalizes via
    // `resolve()` (NOT realpath), while the daemon's workspace registry
    // realpath's the root. Use the realpath form for both sides so the wd-key
    // matches; this is what the front-end folder picker produces in practice
    // (it always surfaces realpath'd paths via `fs:browse`).
    const cwd = realpathSync(dir);
    // 1. Create session pre-registration.
    await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd } },
    });
    // 2. Register the workspace for that cwd.
    const ws = envelopeOf<Workspace>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: cwd } })).json(),
    ).data!;
    expect(ws.session_count).toBe(1);
    // 3. GET ?workspace_id= must surface the pre-existing session.
    const page = envelopeOf<{ items: Session[]; has_more: boolean }>(
      (await appOf(r).inject({ method: 'GET', url: `/api/v1/sessions?workspace_id=${ws.id}` })).json(),
    ).data!;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.workspace_id).toBe(ws.id);
    expect(page.items[0]!.metadata.cwd).toBe(cwd);
  });
});
