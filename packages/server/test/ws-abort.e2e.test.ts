/**
 * WS abort + REST/WS abort symmetry e2e (W7.3 / Chain 4b / P1.4b).
 *
 * **Bootstrap strategy**: spawn the real server, register an active prompt
 * via `PromptService._injectActiveForTest` (avoids running a real
 * agent-core prompt), then exercise:
 *   1. WS `abort` control message → server publishes `prompt.aborted`
 *      synthetic event + sends ack with `aborted: true`.
 *   2. WS `abort` idempotency: second abort returns
 *      `code: 0, payload.aborted: false` (per WS.md §3.4 convention —
 *      NOT REST's 40903, intentional).
 *   3. REST `POST /api/v1/sessions/{sid}/prompts/{pid}:abort`:
 *      - Returns `{aborted: true}` on first call.
 *      - Returns `code: 40903 + data: {aborted: false}` on second
 *        (idempotent already-completed) per REST.md §3.5.
 *   4. **Symmetry**: REST and WS abort dispatch through the same
 *      handler (`IPromptService.abort`). After a REST abort, a WS abort
 *      with the SAME prompt id returns idempotent success. And vice versa.
 *
 * The synthesized `prompt.aborted` event flows through IEventService → WS
 * broadcast so subscribers see it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { IPromptService, PromptService } from '@moonshot-ai/agent-core';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { rawDataToString } from '../src/ws/rawData';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-ws-abort-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-ws-abort-home-'));
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
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
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
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

function injectActivePrompt(
  r: RunningServer,
  sid: string,
  promptId: string,
  turnId: number | null,
): void {
  const impl = r.services.invokeFunction(
    (a) => a.get(IPromptService) as PromptService,
  );
  impl._injectActiveForTest(sid, promptId, turnId);
}

interface Subscriber {
  ws: WebSocket;
  received: Record<string, unknown>[];
}

async function openSubscriber(r: RunningServer, sid: string): Promise<Subscriber> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
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
      payload: { client_id: 'test', subscriptions: [sid] },
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
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received.map((f) => f['type']).join(', ')}`,
  );
}

describe('WS abort control message (W7.3 / Chain 4b)', () => {
  it('on first abort: ack with aborted:true + broadcast prompt.aborted', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_WS_ABORT_${sid}`;
    injectActivePrompt(r, sid, promptId, 5);

    const sub = await openSubscriber(r, sid);
    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a1',
        payload: { session_id: sid, prompt_id: promptId },
      }),
    );

    // Wait for both the ack AND the broadcast prompt.aborted.
    const ack = await waitFor(
      sub.received,
      (f) => f['type'] === 'ack' && f['id'] === 'a1',
    );
    expect(ack['code']).toBe(0);
    const payload = ack['payload'] as { aborted: boolean };
    expect(payload.aborted).toBe(true);

    const promptAborted = await waitFor(
      sub.received,
      (f) => f['type'] === 'prompt.aborted',
    );
    const evPayload = promptAborted['payload'] as { promptId: string };
    expect(evPayload.promptId).toBe(promptId);

    sub.ws.close();
  });

  it('on second abort: ack with code:0 + aborted:false (idempotent per WS.md §3.4)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_WS_DUP_${sid}`;
    injectActivePrompt(r, sid, promptId, null);

    const sub = await openSubscriber(r, sid);
    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a1',
        payload: { session_id: sid, prompt_id: promptId },
      }),
    );
    await waitFor(sub.received, (f) => f['type'] === 'ack' && f['id'] === 'a1');

    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a2',
        payload: { session_id: sid, prompt_id: promptId },
      }),
    );
    const ack = await waitFor(
      sub.received,
      (f) => f['type'] === 'ack' && f['id'] === 'a2',
    );
    expect(ack['code']).toBe(0);
    expect((ack['payload'] as { aborted: boolean }).aborted).toBe(false);

    sub.ws.close();
  });

  it('returns 40402 for an unknown prompt id', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const sub = await openSubscriber(r, sid);
    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a1',
        payload: { session_id: sid, prompt_id: 'prompt_does_not_exist' },
      }),
    );
    const ack = await waitFor(
      sub.received,
      (f) => f['type'] === 'ack' && f['id'] === 'a1',
    );
    expect(ack['code']).toBe(40402);
    sub.ws.close();
  });
});

describe('REST abort + REST/WS symmetry (W7.3 / Chain 4b)', () => {
  it('first REST abort returns {aborted: true}', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_REST_${sid}`;
    injectActivePrompt(r, sid, promptId, 1);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/${promptId}:abort`,
    });
    const env = envelopeOf<{ aborted: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.aborted).toBe(true);
  });

  it('second REST abort returns 40903 + data {aborted: false}', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_REST_DUP_${sid}`;
    injectActivePrompt(r, sid, promptId, 2);
    await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/${promptId}:abort`,
    });
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/${promptId}:abort`,
    });
    const env = envelopeOf<{ aborted: boolean }>(res.json());
    expect(env.code).toBe(40903);
    expect(env.data?.aborted).toBe(false);
  });

  it('REST abort returns 40401 for unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/prompts/prompt_X:abort',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('REST abort returns 40402 for unknown prompt on a known session', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/prompt_missing:abort`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40402);
  });

  it('symmetry: REST abort followed by WS abort on the SAME prompt id returns idempotent WS ack', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_SYM1_${sid}`;
    injectActivePrompt(r, sid, promptId, 3);

    // First abort via REST → success.
    const rest = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/${promptId}:abort`,
    });
    expect(envelopeOf<{ aborted: boolean }>(rest.json()).data?.aborted).toBe(true);

    // Second abort via WS — must be idempotent (code 0 + aborted: false).
    const sub = await openSubscriber(r, sid);
    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a1',
        payload: { session_id: sid, prompt_id: promptId },
      }),
    );
    const ack = await waitFor(
      sub.received,
      (f) => f['type'] === 'ack' && f['id'] === 'a1',
    );
    expect(ack['code']).toBe(0);
    expect((ack['payload'] as { aborted: boolean }).aborted).toBe(false);
    sub.ws.close();
  });

  it('symmetry: WS abort followed by REST abort returns 40903 on REST', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const promptId = `prompt_SYM2_${sid}`;
    injectActivePrompt(r, sid, promptId, 4);

    // First abort via WS.
    const sub = await openSubscriber(r, sid);
    sub.ws.send(
      JSON.stringify({
        type: 'abort',
        id: 'a1',
        payload: { session_id: sid, prompt_id: promptId },
      }),
    );
    await waitFor(sub.received, (f) => f['type'] === 'ack' && f['id'] === 'a1');

    // Second abort via REST — must surface 40903 already_completed.
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts/${promptId}:abort`,
    });
    const env = envelopeOf<{ aborted: boolean }>(res.json());
    expect(env.code).toBe(40903);
    expect(env.data?.aborted).toBe(false);
    sub.ws.close();
  });
});
