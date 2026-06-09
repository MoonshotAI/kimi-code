/**
 * WS ring buffer + resync_required e2e (W5.3 / P0.17).
 *
 * Three flows per WS.md §6:
 *
 *   1. **Replay**: publish N events; client A disconnects; publish M more;
 *      A reconnects with `client_hello.last_seq_by_session[sid]=N`; assert
 *      A receives exactly events N+1..N+M in order.
 *
 *   2. **Resync**: force the buffer to overflow (publish >1000 events).
 *      Client B connects with a stale `last_seq` (older than `oldestSeq`).
 *      Assert B receives a `resync_required` frame for that session, NOT
 *      events.
 *
 *   3. **No-op**: client C connects with `last_seq == current_seq`. Assert
 *      no replay events arrive on the first frames (only the normal ack +
 *      empty `resync_required`).
 *
 * `maxBufferSize` is the default 1000 baked into `WSBroadcastService`. The
 * resync flow publishes 1005 events to trigger eviction; the buffer keeps
 * the last 1000. Publishes go through `IEventService.publish(...)`; ring
 * buffer state and replay queries are read off the daemon-local
 * `IWSBroadcastService` (cast to the concrete class for `_*ForTest`
 * helpers).
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
  IWSBroadcastService,
  startDaemon,
  type RunningDaemon,
} from '../src';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningDaemon[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-resync-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-resync-home-'));
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
}

describe('WS ring buffer + resync_required (W5.3)', () => {
  it('reconnect with last_seq replays buffered events in order', async () => {
    const r = await spawn();

    // Client A: connect, subscribe to sid_test, capture seq up to 5.
    const a1 = await openConn(wsUrl(r.address));
    await receiveType(a1, 'server_hello', 1000);
    a1.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_a1',
        payload: { client_id: 'A', subscriptions: ['sid_test'] },
      }),
    );
    await receiveType(a1, 'ack', 1000);
    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_test') === 1,
      ),
    );

    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    for (let i = 1; i <= 5; i++) {
      bus.publish({ type: `evt.${i}`, sessionId: 'sid_test' } as unknown as Event);
    }
    // Drain events 1..5 off A1's queue.
    for (let i = 1; i <= 5; i++) {
      const ev = await receiveType(a1, `evt.${i}`, 1000);
      expect(ev.seq).toBe(i);
    }

    // Disconnect A1.
    a1.ws.close();
    await waitFor(() =>
      r.services.invokeFunction(
        (acc) => acc.get(ISessionClientsService).subscriberCount('sid_test') === 0,
      ),
    );

    // Publish 3 more events while A is gone (seq 6, 7, 8).
    for (let i = 6; i <= 8; i++) {
      bus.publish({ type: `evt.${i}`, sessionId: 'sid_test' } as unknown as Event);
    }

    // Reconnect with last_seq=5 — should replay 6, 7, 8 in order.
    const a2 = await openConn(wsUrl(r.address));
    await receiveType(a2, 'server_hello', 1000);
    a2.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_a2',
        payload: {
          client_id: 'A',
          subscriptions: ['sid_test'],
          last_seq_by_session: { sid_test: 5 },
        },
      }),
    );

    const evt6 = await receiveType(a2, 'evt.6', 1000);
    const evt7 = await receiveType(a2, 'evt.7', 1000);
    const evt8 = await receiveType(a2, 'evt.8', 1000);
    expect(evt6.seq).toBe(6);
    expect(evt7.seq).toBe(7);
    expect(evt8.seq).toBe(8);

    const ack = await receiveType(a2, 'ack', 1000);
    expect(ack.code).toBe(0);
    const ackPayload = ack.payload as { resync_required: string[] };
    expect(ackPayload.resync_required).toEqual([]);

    a2.ws.close();
  });

  it('client connects with last_seq beyond ring-buffer retention → resync_required', async () => {
    const r = await spawn();

    // Force the buffer to overflow. With the spec-faithful 1000-cap, we
    // publish 1005 events. After that, oldestSeq is 6 (events 1..5 evicted).
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    for (let i = 1; i <= 1005; i++) {
      bus.publish({ type: 'evt', sessionId: 'sid_test' } as unknown as Event);
    }
    expect(broadcast._currentSeqForTest('sid_test')).toBe(1005);
    expect(broadcast._bufferLengthForTest('sid_test')).toBe(1000);
    expect(broadcast._oldestSeqForTest('sid_test')).toBe(6);

    // Client connects with last_seq=3 — gap is too big (events 4, 5 are gone).
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);
    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_resync',
        payload: {
          client_id: 'C',
          subscriptions: ['sid_test'],
          last_seq_by_session: { sid_test: 3 },
        },
      }),
    );

    const resync = await receiveType(conn, 'resync_required', 1000);
    const resyncPayload = resync.payload as {
      session_id: string;
      reason: string;
      current_seq: number;
    };
    expect(resyncPayload.session_id).toBe('sid_test');
    expect(resyncPayload.reason).toBe('buffer_overflow');
    expect(resyncPayload.current_seq).toBe(1005);

    const ack = await receiveType(conn, 'ack', 1000);
    const ackPayload = ack.payload as { resync_required: string[] };
    expect(ackPayload.resync_required).toContain('sid_test');

    conn.ws.close();
  });

  it('caught-up client (last_seq == current_seq) gets no replay, just empty ack', async () => {
    const r = await spawn();
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    bus.publish({ type: 'evt.a', sessionId: 'sid_test' } as unknown as Event);
    bus.publish({ type: 'evt.b', sessionId: 'sid_test' } as unknown as Event);
    bus.publish({ type: 'evt.c', sessionId: 'sid_test' } as unknown as Event);

    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);
    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_uptodate',
        payload: {
          client_id: 'D',
          subscriptions: ['sid_test'],
          last_seq_by_session: { sid_test: 3 }, // == current_seq
        },
      }),
    );

    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    const ackPayload = ack.payload as { resync_required: string[]; accepted_subscriptions: string[] };
    expect(ackPayload.resync_required).toEqual([]);
    expect(ackPayload.accepted_subscriptions).toContain('sid_test');

    // No additional event frames should arrive before the next publish.
    await expect(receiveType(conn, 'evt.a', 200)).rejects.toBeInstanceOf(Error);

    // Now publish — should arrive normally at seq=4.
    bus.publish({ type: 'evt.d', sessionId: 'sid_test' } as unknown as Event);
    const ev = await receiveType(conn, 'evt.d', 1000);
    expect(ev.seq).toBe(4);

    conn.ws.close();
  });

  it('ring buffer evicts oldest event when capacity is exceeded', async () => {
    const r = await spawn();
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    // Publish 1002 — buffer should retain seq 3..1002, oldestSeq=3.
    for (let i = 1; i <= 1002; i++) {
      bus.publish({ type: 'evt', sessionId: 'sid_evict' } as unknown as Event);
    }
    expect(broadcast._currentSeqForTest('sid_evict')).toBe(1002);
    expect(broadcast._bufferLengthForTest('sid_evict')).toBe(1000);
    expect(broadcast._oldestSeqForTest('sid_evict')).toBe(3);

    // getBufferedSince(sid, 2) → resyncRequired (lastSeq+1=3, oldestSeq=3 → NOT resync;
    // lastSeq+1=3 == oldestSeq=3 → NOT resync). Verify boundary.
    const replay = broadcast.getBufferedSince('sid_evict', 2);
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events[0]?.seq).toBe(3);
    expect(replay.events.length).toBe(1000);

    // lastSeq=1 → lastSeq+1=2 < oldestSeq=3 → resync.
    const replay2 = broadcast.getBufferedSince('sid_evict', 1);
    expect(replay2.resyncRequired).toBe(true);
    expect(replay2.events.length).toBe(0);
  });
});
