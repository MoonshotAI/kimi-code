/**
 * WS subscribe + broadcast e2e (W5.2 / P0.16).
 *
 * Boots `startDaemon`, connects 2 real WS clients, asks them to subscribe to
 * the same session, then publishes events via `IEventService.publish` from
 * INSIDE the daemon (using `RunningDaemon.services` to reach the bus).
 *
 * Assertions:
 *   1. Both subscribers receive the same event with `seq=1`.
 *   2. A second event for the same session lands at `seq=2`.
 *   3. Events for a different session don't reach the original subscribers.
 *   4. Per-session seq counters are independent.
 *   5. After one client `unsubscribe`s, only the remaining subscriber gets
 *      the next event.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pino } from 'pino';
import { WebSocket } from 'ws';

import type { Event } from '@moonshot-ai/protocol';
import { IEventService } from '@moonshot-ai/services';

import {
  ISessionClientsService,
  startDaemon,
  type RunningDaemon,
} from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningDaemon[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-broadcast-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-broadcast-home-'));
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function spawn(): Promise<RunningDaemon> {
  const r = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  running.push(r);
  return r;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

interface WsFrame {
  type: string;
  payload?: unknown;
  id?: string;
  code?: number;
  seq?: number;
  session_id?: string;
  [k: string]: unknown;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(String(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) {
        const w = waiters.shift();
        w?.(parsed);
      } else {
        queue.push(parsed);
      }
    });
    ws.once('open', () => resolve({ ws, queue, waiters }));
    ws.once('error', (err) => reject(err));
  });
}

function receive(conn: Conn, timeoutMs: number): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    if (conn.queue.length > 0) {
      resolve(conn.queue.shift()!);
      return;
    }
    const t = setTimeout(() => {
      const idx = conn.waiters.indexOf(waiter);
      if (idx >= 0) conn.waiters.splice(idx, 1);
      reject(new Error(`no message in ${timeoutMs}ms`));
    }, timeoutMs);
    const waiter = (frame: WsFrame): void => {
      clearTimeout(t);
      resolve(frame);
    };
    conn.waiters.push(waiter);
  });
}

async function receiveType(conn: Conn, type: string, timeoutMs: number): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

/**
 * Send a client_hello + subscribe to one session. Drains the resulting
 * `ack` so subsequent `receiveType(conn, ...)` calls see only event frames.
 */
async function helloAndSubscribe(conn: Conn, clientId: string, sessionId: string): Promise<void> {
  await receiveType(conn, 'server_hello', 1000);
  conn.ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: `cli_${clientId}`,
      payload: { client_id: clientId, subscriptions: [sessionId] },
    }),
  );
  await receiveType(conn, 'ack', 1000);
}

describe('WS broadcast + per-session seq (W5.2)', () => {
  it('two subscribers both receive seq=1 then seq=2 for the same session', async () => {
    const r = await spawn();
    const a = await openConn(wsUrl(r.address));
    const b = await openConn(wsUrl(r.address));
    await helloAndSubscribe(a, 'A', 'sid_shared');
    await helloAndSubscribe(b, 'B', 'sid_shared');

    // Wait until the daemon's session-clients index reflects 2 subscribers
    // — otherwise publish races the WS handshake on slow CI.
    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_shared') === 2,
      ),
    );

    r.services.invokeFunction((acc) =>
      acc.get(IEventService).publish({ type: 'evt.x', sessionId: 'sid_shared' } as unknown as Event),
    );

    const e1a = await receiveType(a, 'evt.x', 1000);
    const e1b = await receiveType(b, 'evt.x', 1000);
    expect(e1a.seq).toBe(1);
    expect(e1b.seq).toBe(1);
    expect(e1a.session_id).toBe('sid_shared');

    r.services.invokeFunction((acc) =>
      acc.get(IEventService).publish({ type: 'evt.y', sessionId: 'sid_shared' } as unknown as Event),
    );
    const e2a = await receiveType(a, 'evt.y', 1000);
    const e2b = await receiveType(b, 'evt.y', 1000);
    expect(e2a.seq).toBe(2);
    expect(e2b.seq).toBe(2);

    a.ws.close();
    b.ws.close();
  });

  it('events for other sessions are not delivered to the original subscribers', async () => {
    const r = await spawn();
    const a = await openConn(wsUrl(r.address));
    await helloAndSubscribe(a, 'A', 'sid_x');

    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_x') === 1,
      ),
    );

    r.services.invokeFunction((acc) =>
      acc.get(IEventService).publish({ type: 'evt', sessionId: 'sid_other' } as unknown as Event),
    );
    r.services.invokeFunction((acc) =>
      acc.get(IEventService).publish({ type: 'evt.delivered', sessionId: 'sid_x' } as unknown as Event),
    );

    const ev = await receiveType(a, 'evt.delivered', 1000);
    expect(ev.session_id).toBe('sid_x');
    expect(ev.seq).toBe(1); // first event on sid_x, so seq=1 even though sid_other got seq=1 first
    a.ws.close();
  });

  it('per-session seq counters are independent across subscribers and sessions', async () => {
    const r = await spawn();
    const a = await openConn(wsUrl(r.address));
    const b = await openConn(wsUrl(r.address));
    await helloAndSubscribe(a, 'A', 'sid_alpha');
    await helloAndSubscribe(b, 'B', 'sid_beta');

    await waitFor(() =>
      r.services.invokeFunction((acc) => {
        const sc = acc.get(ISessionClientsService);
        return sc.subscriberCount('sid_alpha') === 1 && sc.subscriberCount('sid_beta') === 1;
      }),
    );

    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    bus.publish({ type: 'a1', sessionId: 'sid_alpha' } as unknown as Event);
    bus.publish({ type: 'b1', sessionId: 'sid_beta' } as unknown as Event);
    bus.publish({ type: 'a2', sessionId: 'sid_alpha' } as unknown as Event);

    const a1 = await receiveType(a, 'a1', 1000);
    const a2 = await receiveType(a, 'a2', 1000);
    const b1 = await receiveType(b, 'b1', 1000);

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1);

    a.ws.close();
    b.ws.close();
  });

  it('unsubscribe stops delivery to that connection only', async () => {
    const r = await spawn();
    const a = await openConn(wsUrl(r.address));
    const b = await openConn(wsUrl(r.address));
    await helloAndSubscribe(a, 'A', 'sid_share');
    await helloAndSubscribe(b, 'B', 'sid_share');
    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_share') === 2,
      ),
    );

    // Client A unsubscribes.
    a.ws.send(
      JSON.stringify({
        type: 'unsubscribe',
        id: 'u_a',
        payload: { session_ids: ['sid_share'] },
      }),
    );
    await receiveType(a, 'ack', 1000);
    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_share') === 1,
      ),
    );

    // Publish a new event; only B should see it.
    r.services.invokeFunction((acc) =>
      acc.get(IEventService).publish({ type: 'after_unsub', sessionId: 'sid_share' } as unknown as Event),
    );

    const ev = await receiveType(b, 'after_unsub', 1000);
    expect(ev.seq).toBe(1);

    // A should NOT receive it within a short window.
    await expect(receiveType(a, 'after_unsub', 300)).rejects.toBeInstanceOf(Error);

    a.ws.close();
    b.ws.close();
  });
});

/** Spin until `cond()` returns true or 2s elapses. */
async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition not satisfied within 2000ms');
}
