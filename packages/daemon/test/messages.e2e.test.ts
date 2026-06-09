/**
 * Messages history end-to-end tests (W7.1 / Chain 3 / P1.3).
 *
 * **Bootstrap strategy**: spawn the real daemon (port 0, tmp lock + bridge
 * home) and exercise the 2 endpoints via `app.inject(...)`. KimiCore is fully
 * constructed via the W3 bridge pattern — fresh tmpdir per test, no `~/.kimi`
 * interference.
 *
 * Coverage matrix per REST.md §3.4:
 *   - GET /api/v1/sessions/{sid}/messages              → Page<Message> + has_more
 *     - Empty session → empty page, has_more=false
 *     - page_size honored (sub-cap)
 *   - GET /api/v1/sessions/{sid}/messages/{mid}        → Message (40403 unknown id)
 *
 * Plus the validation matrix:
 *   - page_size=0                                   → 40001
 *   - before_id + after_id together                 → 40001
 *   - page_size=101 (over SCHEMAS §1.3 cap of 100)  → 40001
 *   - unknown role                                  → 40001
 *
 * Plus the error mapping matrix:
 *   - Unknown session_id                            → 40401
 *   - Known session, missing message_id             → 40403
 *
 * **Note on `getContext` against a freshly-created session**: agent-core's
 * `getContext` requires the session to be loaded into the active session map.
 * Brand-new sessions (via `createSession`) emit no history yet; the bridge's
 * `getContext({sessionId, agentId:'main'})` returns
 * `{history: [], tokenCount: 0}`. The list endpoint surfaces this as
 * `{items:[], has_more:false}` — the test exercises that path. Populated
 * history is unit-tested at the services layer with a mocked bridge (see
 * `packages/services/test/message-service.test.ts`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-messages-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-messages-home-'));
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
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`failed to create session: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

describe('GET /api/v1/sessions/{session_id}/messages — list (W7.1 / Chain 3)', () => {
  it('returns an empty page for a freshly-created session', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ items: unknown[]; has_more: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();
    expect(env.data!.items).toEqual([]);
    expect(env.data!.has_more).toBe(false);
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_missing/messages',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
    expect(env.data).toBeNull();
  });

  it('rejects page_size=0 with code 40001 + details', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages?page_size=0`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(Array.isArray(env.details)).toBe(true);
  });

  it('rejects page_size=101 with code 40001 (SCHEMAS §1.3 cap)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages?page_size=101`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('rejects before_id + after_id together with code 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages?before_id=a&after_id=b`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('rejects unknown role values with code 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages?role=cat`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('accepts page_size + role together (positive)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages?page_size=10&role=assistant`,
    });
    const env = envelopeOf<{ items: unknown[]; has_more: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.items).toEqual([]);
    expect(env.data!.has_more).toBe(false);
  });
});

describe('GET /api/v1/sessions/{session_id}/messages/{message_id} — get (W7.1 / Chain 3)', () => {
  it('returns 40403 (message.not_found) when the id has no matching history entry', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    // The id syntax is opaque; any well-formed id that points at an index
    // outside the empty history surfaces as message.not_found.
    const fakeId = `msg_${sid}_000000`;
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages/${fakeId}`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40403);
    expect(env.data).toBeNull();
    expect(env.msg).toMatch(/does not exist/);
  });

  it('returns 40403 for a malformed message id (parse failure)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/messages/garbage`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40403);
  });

  it('returns 40401 when the session is unknown (regardless of message id shape)', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_missing/messages/msg_anything',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});
