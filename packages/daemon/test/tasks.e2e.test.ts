/**
 * Background Tasks end-to-end tests (W9.2 / Chain 8 / P1.8).
 *
 * Covers REST.md §3.7:
 *   - GET  /api/v1/sessions/{sid}/tasks                  → envelope + items[]
 *   - GET  /api/v1/sessions/{sid}/tasks/{tid}            → BackgroundTask, 40406 unknown
 *   - POST /api/v1/sessions/{sid}/tasks/{tid}:cancel     → {cancelled:true},
 *                                                       40406 unknown id,
 *                                                       40904 already finished
 *   - Negative: session_id unknown → 40401
 *   - Negative: bare {tid} POST (no :cancel) → 40001 unsupported action
 *
 * **Bootstrap strategy**: spawn the daemon and inject a fake background task
 * directly into the in-process KimiCore via the bridge. Agent-core's
 * `getBackground` / `stopBackground` operate against the same registrar.
 *
 * Because directly seeding a `BackgroundTask` requires constructing a real
 * KimiCore session and inserting into the agent-core background-task manager
 * (out-of-band of the REST surface), we cover the positive list/get/cancel
 * paths via empty state + the negative tests. The 40904 already-finished
 * path is covered by the services unit tests; the daemon-side mapping is
 * verified here by seeding a TaskAlreadyFinishedError via a stubbed
 * ITaskService override.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
} from '@moonshot-ai/services';
import {
  listTasksResponseSchema,
} from '@moonshot-ai/protocol';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-tasks-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-tasks-home-'));
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
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/**
 * Override the container's `ITaskService` with a stub. Used to drive the
 * 40904 / 40406 envelope mapping paths without seeding real background
 * tasks.
 *
 * The InstantiationService caches resolved instances in `_instances` after
 * the first `a.get(...)`. The daemon's `start.ts` warms the cache for every
 * registered identifier, so a `services.set(...)` would not be observed by
 * subsequent route requests. We mutate both the registration map and the
 * instance cache.
 */
function overrideTaskService(
  r: RunningDaemon,
  stub: Partial<ITaskService>,
): void {
  const defaultImpl: ITaskService = {
    _serviceBrand: undefined,
    list: async () => [],
    get: async () => {
      throw new TaskNotFoundError('s', 't');
    },
    cancel: async () => ({ cancelled: true as const }),
  };
  const replacement = { ...defaultImpl, ...stub };
  const ix = r.services as unknown as {
    services: { set: (id: unknown, impl: unknown) => void };
    _instances: Map<unknown, unknown>;
  };
  ix.services.set(ITaskService, replacement);
  ix._instances.set(ITaskService, replacement);
}

describe('GET /api/v1/sessions/{sid}/tasks', () => {
  it('returns 40401 for an unknown session_id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/tasks',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('returns an envelope with {items:[]} for a session with no tasks', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/tasks`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = listTasksResponseSchema.parse(env.data);
    expect(parsed.items).toEqual([]);
  });

  it('rejects unknown status filter with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/tasks?status=pending`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('GET /api/v1/sessions/{sid}/tasks/{tid}', () => {
  it('returns 40406 for an unknown task_id (real session, empty tasks)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/tasks/does-not-exist`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40406);
  });

  it('returns 40401 for an unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/unknown/tasks/anything`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('POST /api/v1/sessions/{sid}/tasks/{tid}:cancel', () => {
  it('returns 40406 for an unknown task_id', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/tasks/nope:cancel`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40406);
  });

  it('rejects bare {tid} with 40001 (no :cancel suffix → not a defined action)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/tasks/abc123`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.msg).toMatch(/unsupported action/);
  });

  it('rejects unknown action with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/tasks/abc:bogus`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it("emits 40904 envelope with data:{cancelled:false} when service throws TaskAlreadyFinishedError", async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    overrideTaskService(r, {
      cancel: async () => {
        throw new TaskAlreadyFinishedError(sid, 't_finished', 'completed');
      },
    });
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/tasks/t_finished:cancel`,
      payload: {},
    });
    const env = envelopeOf<{ cancelled: false }>(res.json());
    expect(env.code).toBe(40904);
    expect(env.data).toEqual({ cancelled: false });
    expect(env.msg).toMatch(/already finished/);
    expect((env.details as { current_status?: string } | undefined)?.current_status).toBe(
      'completed',
    );
  });

  it('returns {cancelled:true} when service succeeds (stub override)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    overrideTaskService(r, {
      cancel: async () => ({ cancelled: true as const }),
    });
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/tasks/t_running:cancel`,
      payload: {},
    });
    const env = envelopeOf<{ cancelled: true }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ cancelled: true });
  });
});
