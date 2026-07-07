/**
 * WS durable journal + resync_required e2e (v2 sync protocol).
 *
 * Flows:
 *
 *   1. **Replay**: publish N events; client A disconnects; publish M more;
 *      A reconnects with `client_hello.cursors[sid] = {seq: N}`; assert A
 *      receives exactly events N+1..N+M in order.
 *
 *   2. **Resync**: publish more than the replay cap (1000). Client B
 *      connects with a cursor whose gap exceeds the cap. Assert B receives
 *      `resync_required(buffer_overflow)`, NOT events.
 *
 *   3. **No-op**: client C connects with `cursor.seq == current_seq`. Assert
 *      no replay events arrive (only the ack with empty `resync_required`).
 *
 *   4. **Replay-cap boundaries**: a gap of exactly 1000 is served; 1001 is
 *      a resync. Memory-tail eviction no longer forces resyncs — the gap is
 *      served from the on-disk journal when it reaches behind the tail.
 *
 * Publishes go through `IEventService.publish(...)`; dispatch is async
 * (per-session queue), so tests drain via `_drainForTest` before asserting
 * watermark state.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pino } from 'pino';
import { WebSocket } from 'ws';

import type { Event } from '@moonshot-ai/protocol';
import { IEventService } from '@moonshot-ai/agent-core';

import {
  ISessionClientsService,
  IWSBroadcastService,
  startServer,
  type RunningServer,
} from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { rawDataToString } from '../src/ws/rawData';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-ws-resync-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-ws-resync-home-'));
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

async function spawn(): Promise<RunningServer> {
  const r = await startServer({
    serviceOverrides: [fixedTokenAuth()],
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
  epoch?: string;
  volatile?: boolean;
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
    const ws = new WebSocket(url, ['kimi-code.bearer.test-token']);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(rawDataToString(data)) as WsFrame;
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

describe('WS durable journal + resync_required (v2)', () => {
  it('reconnect with a cursor replays buffered events in order', async () => {
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
      expect(ev.epoch).toMatch(/^ep_/);
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

    // Reconnect with cursor seq=5 — should replay 6, 7, 8 in order.
    const a2 = await openConn(wsUrl(r.address));
    await receiveType(a2, 'server_hello', 1000);
    a2.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_a2',
        payload: {
          client_id: 'A',
          subscriptions: ['sid_test'],
          cursors: { sid_test: { seq: 5 } },
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
    const ackPayload = ack.payload as {
      resync_required: string[];
      cursors?: Record<string, { seq: number; epoch?: string }>;
    };
    expect(ackPayload.resync_required).toEqual([]);
    expect(ackPayload.cursors?.['sid_test']?.seq).toBe(8);
    expect(ackPayload.cursors?.['sid_test']?.epoch).toMatch(/^ep_/);

    a2.ws.close();
  });

  it('client connects with a gap beyond the replay cap → resync_required(buffer_overflow)', async () => {
    const r = await spawn();

    // Publish past the replay cap. With the 1000-event cap, a client at
    // seq=3 faces a 1002-event gap — snapshot rebuild is cheaper.
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    for (let i = 1; i <= 1005; i++) {
      bus.publish({ type: 'evt', sessionId: 'sid_test' } as unknown as Event);
    }
    await broadcast._drainForTest('sid_test');
    expect(broadcast._currentSeqForTest('sid_test')).toBe(1005);
    expect(broadcast._bufferLengthForTest('sid_test')).toBe(1000);

    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);
    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_resync',
        payload: {
          client_id: 'C',
          subscriptions: ['sid_test'],
          cursors: { sid_test: { seq: 3 } },
        },
      }),
    );

    const resync = await receiveType(conn, 'resync_required', 1000);
    const resyncPayload = resync.payload as {
      session_id: string;
      reason: string;
      current_seq: number;
      epoch?: string;
    };
    expect(resyncPayload.session_id).toBe('sid_test');
    expect(resyncPayload.reason).toBe('buffer_overflow');
    expect(resyncPayload.current_seq).toBe(1005);
    expect(resyncPayload.epoch).toMatch(/^ep_/);

    const ack = await receiveType(conn, 'ack', 1000);
    const ackPayload = ack.payload as { resync_required: string[] };
    expect(ackPayload.resync_required).toContain('sid_test');

    conn.ws.close();
  });

  it('cursor from a different epoch → resync_required(epoch_changed)', async () => {
    const r = await spawn();
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    bus.publish({ type: 'evt.a', sessionId: 'sid_epoch' } as unknown as Event);
    await broadcast._drainForTest('sid_epoch');

    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);
    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_epoch',
        payload: {
          client_id: 'E',
          subscriptions: ['sid_epoch'],
          cursors: { sid_epoch: { seq: 1, epoch: 'ep_FROM_ANOTHER_LIFE' } },
        },
      }),
    );

    const resync = await receiveType(conn, 'resync_required', 1000);
    const resyncPayload = resync.payload as { reason: string; current_seq: number };
    expect(resyncPayload.reason).toBe('epoch_changed');
    expect(resyncPayload.current_seq).toBe(1);

    conn.ws.close();
  });

  it('caught-up client (cursor.seq == current_seq) gets no replay, just empty ack', async () => {
    const r = await spawn();
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    bus.publish({ type: 'evt.a', sessionId: 'sid_test' } as unknown as Event);
    bus.publish({ type: 'evt.b', sessionId: 'sid_test' } as unknown as Event);
    bus.publish({ type: 'evt.c', sessionId: 'sid_test' } as unknown as Event);
    await broadcast._drainForTest('sid_test');

    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);
    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_uptodate',
        payload: {
          client_id: 'D',
          subscriptions: ['sid_test'],
          cursors: { sid_test: { seq: 3 } }, // == current_seq
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

  it('replay-cap boundaries: gap of exactly 1000 served, 1001 resyncs', async () => {
    const r = await spawn();
    const bus = r.services.invokeFunction((acc) => acc.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (acc) => acc.get(IWSBroadcastService),
    ) as WSBroadcastService;
    for (let i = 1; i <= 1002; i++) {
      bus.publish({ type: 'evt', sessionId: 'sid_evict' } as unknown as Event);
    }
    await broadcast._drainForTest('sid_evict');
    expect(broadcast._currentSeqForTest('sid_evict')).toBe(1002);
    expect(broadcast._bufferLengthForTest('sid_evict')).toBe(1000);

    // Gap of exactly 1000 (cursor.seq=2) → served; first event past the
    // memory tail (seq 3..1002 retained) is still seq 3.
    const replay = await broadcast.getBufferedSince('sid_evict', { seq: 2 });
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events[0]?.seq).toBe(3);
    expect(replay.events.length).toBe(1000);

    // Gap of 1001 (cursor.seq=1) → buffer_overflow resync.
    const replay2 = await broadcast.getBufferedSince('sid_evict', { seq: 1 });
    expect(replay2.resyncRequired).toBe('buffer_overflow');
    expect(replay2.events.length).toBe(0);
  });
});
