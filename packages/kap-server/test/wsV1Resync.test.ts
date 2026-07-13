/**
 * `/api/v1/ws` resync / replay — verifies the v1 WS protocol end-to-end:
 * server_hello, client_hello, subscribe ack, sequenced event delivery, and
 * cursor-based replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DomainEvent,
  IEventBus,
  IAgentLifecycleService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
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

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.getHandle('main') === undefined) {
      await agents.create({ agentId: 'main' });
    }
  }

  function withToken<T extends Record<string, unknown>>(payload: T): T & { token: string } {
    return { ...payload, token: server!.authTokenService.getToken() };
  }

  function emitAgentEvent(sessionId: string, event: DomainEvent): void {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const main = agents.getHandle('main');
    expect(main).toBeDefined();
    main!.accessor.get(IEventBus).publish(event);
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

  it('delivers a sequenced durable event to a subscribed connection', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as DomainEvent);

    const ev = await c.next((f) => f.type === 'turn.started');
    expect(ev.seq).toBeGreaterThanOrEqual(1);
    expect(ev.session_id).toBe(sid);
    expect(ev.volatile).toBeUndefined();

    c.ws.close();
    await c.closed;
  });

  it('replays durable events since a cursor on reconnect', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);

    // First connection — subscribe, generate two durable events.
    const c1 = await openConn(wsUrl, server!.authTokenService.getToken());
    await c1.next((f) => f.type === 'server_hello');
    c1.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c1.next((f) => f.type === 'ack' && f.id === 'h1');
    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as DomainEvent);
    emitAgentEvent(sid, { type: 'turn.ended', turnId: 1 } as unknown as DomainEvent);
    await c1.next((f) => f.type === 'turn.ended');
    c1.ws.close();
    await c1.closed;

    // Second connection — replay from seq 1, expect only seq 2.
    const c2 = await openConn(wsUrl, server!.authTokenService.getToken());
    await c2.next((f) => f.type === 'server_hello');
    c2.send({
      type: 'client_hello',
      id: 'h2',
      payload: withToken({ client_id: 'cli', subscriptions: [sid], cursors: { [sid]: { seq: 1 } } }),
    });
    const replayed = await c2.next((f) => f.type === 'turn.ended');
    expect(replayed.seq).toBeGreaterThanOrEqual(2);
    const ack2 = await c2.next((f) => f.type === 'ack' && f.id === 'h2');
    expect(ack2.payload).toMatchObject({ accepted_subscriptions: [sid] });

    c2.ws.close();
    await c2.closed;
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

  it('delivers only the allowlisted agent events via agent_filter', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);

    // Add a second agent to the same session so we can distinguish sources.
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sid);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const sub = await agents.create({ agentId: 'agent-0' });

    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        agent_filter: { [sid]: ['main'] },
      }),
    });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    // Emit one durable event per agent — only `main` is allowlisted.
    agents
      .getHandle('main')!
      .accessor.get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 1 } as unknown as DomainEvent);
    sub.accessor
      .get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 2 } as unknown as DomainEvent);

    const ev = await c.next((f) => f.type === 'turn.ended');
    expect(ev.payload).toMatchObject({ agentId: 'main' });

    // The agent-0 event is filtered out — no second turn.ended arrives.
    await expect(c.next((f) => f.type === 'turn.ended', 300)).rejects.toThrow();

    c.ws.close();
    await c.closed;
  });
});
