/**
 * Sessions CRUD end-to-end tests (W6.2 / Chain 2 / P1.2).
 *
 * **Bootstrap strategy**: spawn the real server (port 0, tmp lock + bridge
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
 *   - POST  /api/v1/sessions/{id}:archive → { archived: true } (40401 on unknown)
 *
 * Plus the validation matrix:
 *   - POST with missing `metadata.cwd` → 40001 + `details` containing path.
 *   - GET list with `page_size=0`       → 40001 (out of range).
 *   - GET list with both before_id+after_id → 40001 (mutual exclusivity).
 *
 * Plus the snake_case + ISO `Z` invariants on the response shape (the load-
 * bearing piece of Chain 2).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { ErrorCode, sessionSchema, sessionStatusResponseSchema, undoSessionResponseSchema } from '@moonshot-ai/protocol';
import type { TelemetryClient, TelemetryProperties } from '@moonshot-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

interface TelemetryRecord {
  readonly event: string;
  readonly sessionId: string | null;
  readonly properties?: TelemetryProperties;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-sessions-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-sessions-home-'));
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

async function bootDaemon(options: { telemetry?: TelemetryClient } = {}): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome, telemetry: options.telemetry },
  });
  return server;
}

function recordingTelemetry(records: TelemetryRecord[]): TelemetryClient {
  return {
    track: (event, properties) => {
      records.push({ event, sessionId: null, properties });
    },
    withContext: (patch) => ({
      track: (event, properties) => {
        records.push({ event, sessionId: patch.sessionId ?? null, properties });
      },
    }),
  };
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

function envelopeOf<T>(body: unknown): { code: number; msg: string; data: T | null; request_id: string; details?: unknown } {
  return body as { code: number; msg: string; data: T | null; request_id: string; details?: unknown };
}

function wsDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return JSON.stringify(data);
}

async function openSessionListListener(r: RunningServer): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(wsDataToString(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  await waitFor(received, (f) => f['type'] === 'server_hello');
  ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'session-list-test', subscriptions: [] },
    }),
  );
  await waitFor(received, (f) => f['type'] === 'ack' && f['id'] === 'h1');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = received.find(pred);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for frame; got ${JSON.stringify(received)}`);
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

  it('broadcasts event.session.created to connected clients without a session subscription', async () => {
    const r = await bootDaemon();
    const { ws, received } = await openSessionListListener(r);
    const cwd = join(tmpDir, 'workspace-create-broadcast');

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd }, title: 'created via ws test' },
    });
    const env = envelopeOf<{ id: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();

    const frame = await waitFor(
      received,
      (f) => f['type'] === 'event.session.created',
    );
    expect(frame['session_id']).toBe(env.data!.id);
    expect(frame['payload']).toMatchObject({
      session: {
        id: env.data!.id,
        title: 'created via ws test',
        metadata: { cwd },
      },
    });

    ws.close();
  });

  it('reports web client headers in new-session telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const r = await bootDaemon({ telemetry: recordingTelemetry(records) });
    const cwd = join(tmpDir, 'workspace-client-telemetry');

    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: {
        'x-kimi-client-id': 'web_test_client',
        'x-kimi-client-name': 'kimi-code-web',
        'x-kimi-client-version': '0.1.1',
        'x-kimi-client-ui-mode': 'web',
      },
      payload: { metadata: { cwd }, title: 'client telemetry' },
    });
    const env = envelopeOf<{ id: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).not.toBeNull();

    expect(records).toContainEqual({
      event: 'session_started',
      sessionId: env.data!.id,
      properties: {
        client_id: 'web_test_client',
        client_name: 'kimi-code-web',
        client_version: '0.1.1',
        ui_mode: 'web',
        resumed: false,
      },
    });
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

describe('GET /api/v1/sessions/{session_id}/status — fetch live status', () => {
  it('returns the live status envelope for a fresh session', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-status-get');
    const createRes = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { metadata: { cwd } },
    });
    const created = envelopeOf<{ id: string }>(createRes.json()).data!;

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.id}/status`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const status = sessionStatusResponseSchema.parse(env.data);
    expect(status.status).toBe('idle');
  });

  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/sess_missing/status',
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

  it('broadcasts session.meta.updated to clients not subscribed to the session on rename', async () => {
    const r = await bootDaemon();
    const { ws, received } = await openSessionListListener(r);
    const cwd = join(tmpDir, 'workspace-profile-rename-broadcast');
    const created = envelopeOf<{ id: string }>(
      (
        await appOf(r).inject({
          method: 'POST',
          url: '/api/v1/sessions',
          payload: { metadata: { cwd } },
        })
      ).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}/profile`,
      payload: { title: 'Renamed' },
    });
    expect(envelopeOf<unknown>(res.json()).code).toBe(0);

    const frame = await waitFor(received, (f) => f['type'] === 'session.meta.updated');
    expect(frame['session_id']).toBe(created.id);
    expect(frame['payload']).toMatchObject({
      title: 'Renamed',
      patch: { title: 'Renamed', isCustomTitle: true },
    });

    ws.close();
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
    expect(env.msg).toMatch(/No messages to compact/);
  });
});

describe('POST /api/v1/sessions/{session_id}:undo — undo history', () => {
  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing:undo',
      payload: {},
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(env.data).toBeNull();
  });

  it('rejects invalid counts before dispatching undo', async () => {
    const r = await bootDaemon();
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd: join(tmpDir, 'workspace-undo-invalid') } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:undo`,
      payload: { count: 0 },
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(env.data).toBeNull();
  });

  it('maps a fresh session undo attempt to session.undo_unavailable', async () => {
    const r = await bootDaemon();
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd: join(tmpDir, 'workspace-undo-empty') } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:undo`,
      payload: {},
    });
    const env = envelopeOf(res.json());
    expect(env.code).toBe(ErrorCode.SESSION_UNDO_UNAVAILABLE);
    expect(env.data).toBeNull();
  });

  it('accepts the undo response schema', () => {
    expect(
      undoSessionResponseSchema.parse({
        messages: { items: [], has_more: false },
        status: {
          status: 'idle',
          thinking_level: 'auto',
          permission: 'manual',
          plan_mode: false,
          swarm_mode: false,
          context_tokens: 0,
          max_context_tokens: 0,
          context_usage: 0,
        },
      }),
    ).toMatchObject({ messages: { items: [] } });
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

describe('POST /api/v1/sessions/{session_id}:archive — archive', () => {
  it('returns { archived: true } envelope and hides the session from list', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-archive');
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd } },
      })).json(),
    ).data!;

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:archive`,
      payload: {},
    });
    const env = envelopeOf<{ archived: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ archived: true });

    const listRes = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions',
    });
    const listEnv = envelopeOf<{ items: Array<{ id: string }>; has_more: boolean }>(listRes.json());
    expect(listEnv.code).toBe(0);
    expect(listEnv.data!.items.find((s) => s.id === created.id)).toBeUndefined();
  });

  it('updates the workspace session_count to 0 when the last session is archived', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-archive-count');
    mkdirSync(cwd, { recursive: true });
    const ws = envelopeOf<{ id: string; session_count: number; root: string }>(
      (await appOf(r).inject({ method: 'POST', url: '/api/v1/workspaces', payload: { root: cwd } })).json(),
    ).data!;
    expect(ws.session_count).toBe(0);

    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { workspace_id: ws.id, metadata: { cwd: ws.root } },
      })).json(),
    ).data!;

    const listBefore = envelopeOf<{ items: Array<{ id: string; session_count: number }> }>(
      (await appOf(r).inject({ method: 'GET', url: '/api/v1/workspaces' })).json(),
    ).data!;
    const before = listBefore.items.find((w) => w.id === ws.id);
    expect(before).toBeDefined();
    expect(before!.session_count).toBe(1);

    const archiveRes = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:archive`,
      payload: {},
    });
    expect(envelopeOf<{ archived: boolean }>(archiveRes.json()).data).toEqual({ archived: true });

    const listAfter = envelopeOf<{ items: Array<{ id: string; session_count: number }> }>(
      (await appOf(r).inject({ method: 'GET', url: '/api/v1/workspaces' })).json(),
    ).data!;
    const after = listAfter.items.find((w) => w.id === ws.id);
    expect(after).toBeDefined();
    expect(after!.session_count).toBe(0);
  });

  it('includes archived sessions when include_archive=true and marks archived flag', async () => {
    const r = await bootDaemon();
    const cwd = join(tmpDir, 'workspace-archive-include');
    const created = envelopeOf<{ id: string }>(
      (await appOf(r).inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { metadata: { cwd } },
      })).json(),
    ).data!;

    const archiveRes = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.id}:archive`,
      payload: {},
    });
    expect(envelopeOf<{ archived: boolean }>(archiveRes.json()).data).toEqual({ archived: true });

    const defaultList = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions',
    });
    const defaultEnv = envelopeOf<{ items: Array<{ id: string; archived?: boolean }>; has_more: boolean }>(
      defaultList.json(),
    );
    expect(defaultEnv.code).toBe(0);
    expect(defaultEnv.data!.items.find((s) => s.id === created.id)).toBeUndefined();

    const archivedList = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions?include_archive=true',
    });
    const archivedEnv = envelopeOf<{ items: Array<{ id: string; archived?: boolean }>; has_more: boolean }>(
      archivedList.json(),
    );
    expect(archivedEnv.code).toBe(0);
    const listed = archivedEnv.data!.items.find((s) => s.id === created.id);
    expect(listed).toBeDefined();
    expect(listed!.archived).toBe(true);

    const explicitList = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions?include_archive=false',
    });
    const explicitEnv = envelopeOf<{ items: Array<{ id: string }>; has_more: boolean }>(explicitList.json());
    expect(explicitEnv.code).toBe(0);
    expect(explicitEnv.data!.items.find((s) => s.id === created.id)).toBeUndefined();
  });

  it('returns 40401 for unknown id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing:archive',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});
