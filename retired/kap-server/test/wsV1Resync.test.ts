/**
 * `/api/v1/ws` — verifies the v1 WS protocol end-to-end: server_hello,
 * client_hello subscribe ack, and epoch-mismatch resync signaling.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Frame {
  type: string;
  id?: string;
  seq?: number;
  session_id?: string;
  payload?: Record<string, unknown>;
  volatile?: boolean;
  offset?: number;
}

interface Conn {
  ws: WebSocket;
  frames: Frame[];
  waiters: Array<(f: Frame) => void>;
  closed: Promise<void>;
  send: (f: unknown) => void;
  next: (pred: (f: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
}

function openConn(url: string, token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse((data as Buffer).toString()) as Frame;
      } catch {
        return;
      }
      const w = waiters.shift();
      if (w) w(frame);
      else frames.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        waiters,
        closed,
        send: (f) => ws.send(JSON.stringify(f)),
        next: (pred, timeoutMs = 2000) =>
          new Promise((res, rej) => {
            const idx = frames.findIndex(pred);
            if (idx >= 0) {
              res(frames.splice(idx, 1)[0]!);
              return;
            }
            // Absolute deadline so non-matching frames (e.g. global
            // `event.session.status_changed` that bypass an agent_filter)
            // don't clear the timeout and strand the waiter forever: each
            // non-match re-arms against the time remaining to the deadline.
            const deadline = Date.now() + timeoutMs;
            let t: ReturnType<typeof setTimeout>;
            const waiter = (f: Frame): void => {
              clearTimeout(t);
              if (pred(f)) res(f);
              else {
                frames.push(f);
                waiters.push(waiter);
                arm();
              }
            };
            const arm = (): void => {
              const left = deadline - Date.now();
              if (left <= 0) {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                rej(new Error('timeout waiting for frame'));
                return;
              }
              t = setTimeout(() => {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                rej(new Error('timeout waiting for frame'));
              }, left);
            };
            arm();
            waiters.push(waiter);
          }),
      }),
    );
    ws.once('error', reject);
  });
}

describe('server-v2 /api/v1/ws resync', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-wsv1-test-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  function withToken<T extends Record<string, unknown>>(payload: T): T & { token: string } {
    return { ...payload, token: server!.authTokenService.getToken() };
  }

  it('server_hello then client_hello ack with accepted subscription', async () => {
    const sid = await createSession();
    const c = await openConn(wsUrl, server!.authTokenService.getToken());

    const hello = await c.next((f) => f.type === 'server_hello');
    expect(hello.payload).toMatchObject({ protocol_version: 2 });

    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({ client_id: 'cli', subscriptions: [sid] }),
    });
    const ack = await c.next((f) => f.type === 'ack' && f.id === 'h1');
    expect(ack.payload).toMatchObject({ accepted_subscriptions: [sid], resync_required: [] });

    c.ws.close();
    await c.closed;
  });

  it('sends resync_required on epoch mismatch', async () => {
    const sid = await createSession();
    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        cursors: { [sid]: { seq: 0, epoch: 'ep_wrong' } },
      }),
    });
    const rs = await c.next((f) => f.type === 'resync_required');
    expect(rs.payload).toMatchObject({ session_id: sid, reason: 'epoch_changed' });

    c.ws.close();
    await c.closed;
  });
});
