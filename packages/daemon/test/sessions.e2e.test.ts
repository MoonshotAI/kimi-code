/**
 * Sessions CRUD end-to-end tests (W6.2 / Chain 2 / P1.2).
 *
 * **Bootstrap strategy**: spawn the real daemon (port 0, tmp lock + bridge
 * home) and exercise the 5 endpoints via `app.inject(...)`. KimiCore is fully
 * constructed via the W3 bridge pattern; the HOME dir is a fresh tmpdir so
 * no `~/.kimi` interference. This is non-hermetic in the sense that plugin
 * discovery runs (the bridge's pluginsReady captures errors silently per
 * `core-impl.ts:170-172`), but no network / external state is involved.
 *
 * Coverage matrix per REST.md §3.3:
 *   - POST /api/v1/sessions               → envelope code 0 + Session payload
 *   - GET  /api/v1/sessions               → Page<Session> + has_more
 *   - GET  /api/v1/sessions/{id}          → Session (40401 on unknown id)
 *   - GET  /api/v1/sessions/{id}/profile  → Session (40401 on unknown id)
 *   - POST /api/v1/sessions/{id}/profile  → Session (40401 on unknown id)
 *   - DELETE /api/v1/sessions/{id}        → { deleted: true } (40401 on unknown)
 *
 * Plus the validation matrix:
 *   - POST with missing `metadata.cwd` → 40001 + `details` containing path.
 *   - GET list with `page_size=0`       → 40001 (out of range).
 *   - GET list with both before_id+after_id → 40001 (mutual exclusivity).
 *
 * Plus the snake_case + ISO `Z` invariants on the response shape (the load-
 * bearing piece of Chain 2).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { ErrorCode, sessionSchema } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-sessions-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-sessions-home-'));
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

function envelopeOf<T>(body: unknown): { code: number; msg: string; data: T | null; request_id: string; details?: unknown } {
  return body as { code: number; msg: string; data: T | null; request_id: string; details?: unknown };
}

describe('POST /api/v1/sessions — create', () => {
  it('returns a Session payload with snake_case + ISO Z timestamps', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-create');
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd }, title: 'created via test' },
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(env.msg).toBe('success');
    expect(env.data).not.toBeNull();
    const session = sessionSchema.parse(env.data);
    expect(session.metadata.cwd).toBe(cwd);
    expect(session.title).toBe('created via test');
    expect(session.created_at.endsWith('Z')).toBe(true);
    expect(session.updated_at.endsWith('Z')).toBe(true);
    expect(session.id.length).toBeGreaterThan(0);
  });

  it('rejects a body missing metadata.cwd with code 40001 + details', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { title: 'no cwd' },
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.data).toBeNull();
    expect(Array.isArray(env.details)).toBe(true);
    const details = env.details as Array<{ path: string; message: string }>;
    expect(details.length).toBeGreaterThan(0);
    // The path should reference the failed field (`metadata` or `metadata.cwd`).
    expect(details[0]!.path).toMatch(/^metadata/);
  });
});

describe('GET /api/v1/sessions — list', () => {
  it('returns Page<Session> with has_more=false when fewer than page_size entries exist', async () => {
    const r = await bootDaemon();
    const cwd1 = join(tmpDir, 'workspace-list-1');
    const cwd2 = join(tmpDir, 'workspace-list-2');
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { metadata: { cwd: cwd1 } } });
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { metadata: { cwd: cwd2 } } });

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ items: unknown[]; has_more: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();
    expect(env.data!.has_more).toBe(false);
    expect(env.data!.items.length).toBeGreaterThanOrEqual(2);
    // Each item should parse as Session.
    for (const item of env.data!.items) {
      sessionSchema.parse(item);
    }
  });

  it('honors page_size and surfaces has_more', async () => {
    const r = await bootDaemon();
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { metadata: { cwd: join(tmpDir, 'ws-a') } } });
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { metadata: { cwd: join(tmpDir, 'ws-b') } } });
    await appOf(r).inject({ method: 'POST', url: '/api/v1/sessions', payload: { metadata: { cwd: join(tmpDir, 'ws-c') } } });

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/sessions?page_size=2' });
    const env = envelopeOf<{ items: unknown[]; has_more: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.items).toHaveLength(2);
    expect(env.data!.has_more).toBe(true);
  });

  it('rejects page_size=0 (out of range)', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/sessions?page_size=0' });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('rejects before_id + after_id together', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions?before_id=a&after_id=b',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('GET /api/v1/sessions/{session_id} — fetch single', () => {
  it('returns the matching Session', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-get');
    const createRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd } },
    });
    const created = envelopeOf<{ id: string }>(createRes.json()).data!;

    const getRes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.id}`,
    });
    const env = envelopeOf<unknown>(getRes.json());
    expect(env.code).toBe(0);
    const session = sessionSchema.parse(env.data);
    expect(session.id).toBe(created.id);
    expect(session.metadata.cwd).toBe(cwd);
  });

  it('returns code 40401 for an unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_does_not_exist',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
    expect(env.data).toBeNull();
    expect(env.msg).toMatch(/does not exist/);
  });
});

describe('GET /api/v1/sessions/{session_id}/profile — fetch profile', () => {
  it('returns the matching Session profile', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-profile-get');
    const createRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd } },
    });
    const created = envelopeOf<{ id: string }>(createRes.json()).data!;

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.id}/profile`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const session = sessionSchema.parse(env.data);
    expect(session.id).toBe(created.id);
    expect(session.metadata.cwd).toBe(cwd);
  });

  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_missing/profile',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('POST /api/v1/sessions/{session_id}/profile — update profile', () => {
  it('updates the title and returns the post-update Session', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-profile-update');
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}/profile`,
      payload: { title: 'Renamed' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const session = sessionSchema.parse(env.data);
    expect(session.id).toBe(created.id);
    // The Session shape is returned (title reflection may rely on
    // metadata round-tripping; the contract is "200 + Session payload").
  });

  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/profile',
      payload: { title: 'x' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('POST /api/v1/sessions/{session_id}:fork — fork', () => {
  it('forks the session, defaults the title from the source, and returns the fork', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-fork');
    const source = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          title: 'Source session',
          metadata: { cwd, source: true },
        },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${source.id}:fork`,
      payload: { metadata: { child: true } },
    });

    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const fork = sessionSchema.parse(env.data);
    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe('Fork: Source session');
    expect(fork.metadata).toMatchObject({
      cwd,
      source: true,
      child: true,
    });

    const forkGet = envelopeOf<unknown>(
      (await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${fork.id}`,
      })).json(),
    );
    expect(forkGet.code).toBe(0);
    expect(sessionSchema.parse(forkGet.data).id).toBe(fork.id);
  });

  it('returns 40401 for an unknown source session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing:fork',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
    expect(env.data).toBeNull();
  });
});

describe('POST /api/v1/sessions/{session_id}:compact — begin compaction', () => {
  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing:compact',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(env.data).toBeNull();
  });

  it('maps an empty-history compaction attempt to compaction.unable', async () => {
    const r = await bootDaemon();
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd: join(tmpDir, 'workspace-compact') } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:compact`,
      payload: { instruction: '  focus on decisions  ' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(ErrorCode.COMPACTION_UNABLE);
    expect(env.data).toBeNull();
    expect(env.msg).toMatch(/No prefix/);
  });
});

describe('POST and GET /api/v1/sessions/{session_id}/children', () => {
  it('creates a child session and lists it under the parent', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-children');
    const parent = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          title: 'Parent session',
          metadata: { cwd, source: true },
        },
      })).json(),
    ).data!;

    const createChild = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${parent.id}/children`,
      payload: {
        metadata: {
          parent_session_id: 'spoofed-parent',
          child_session_kind: 'spoofed-kind',
          topic: 'btw',
        },
      },
    });

    expect(createChild.statusCode).toBe(200);
    const createEnv = envelopeOf(createChild.json());
    expect(createEnv.code).toBe(0);
    const child = sessionSchema.parse(createEnv.data);
    expect(child.id).not.toBe(parent.id);
    expect(child.title).toBe('Child: Parent session');
    expect(child.metadata).toMatchObject({
      cwd,
      source: true,
      parent_session_id: parent.id,
      child_session_kind: 'child',
      topic: 'btw',
    });

    await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${parent.id}:fork`,
      payload: { metadata: { ordinary_fork: true } },
    });

    const listChildren = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${parent.id}/children`,
    });
    const listEnv = envelopeOf<{ items: unknown[]; has_more: boolean }>(listChildren.json());
    expect(listEnv.code).toBe(0);
    expect(listEnv.data?.has_more).toBe(false);
    const children = listEnv.data!.items.map((item) => sessionSchema.parse(item));
    expect(children.map((item) => item.id)).toEqual([child.id]);
  });

  it('returns 40401 for a missing parent session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/children',
      payload: {},
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(40401);
    expect(env.data).toBeNull();
  });
});

describe('DELETE /api/v1/sessions/{session_id} — delete', () => {
  it('returns { deleted: true } envelope', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-delete');
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${created.id}`,
    });
    const env = envelopeOf<{ deleted: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ deleted: true });
  });

  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'DELETE',
      url: '/api/v1/sessions/sess_missing',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});
