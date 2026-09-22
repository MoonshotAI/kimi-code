import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Event2,
  IEventBus,
  IAgentLifecycleService,
  closeSessionById,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-wsv1-test-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterAll(async () => {
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
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.handleOf('main') === undefined) {
      await agents.create({ agentId: 'main' });
    }
  }

  function withToken<T extends Record<string, unknown>>(payload: T): T & { token: string } {
    return { ...payload, token: server!.authTokenService.getToken() };
  }

  function emitAgentEvent(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const main = agents.handleOf('main');
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

    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);

    const ev = await c.next((f) => f.type === 'turn.started');
    expect(ev.seq).toBeGreaterThanOrEqual(1);
    expect(ev.session_id).toBe(sid);
    expect(ev.volatile).toBeUndefined();

    c.ws.close();
    await c.closed;
  });

  it('resumes cold sessions on subscribe and streams events from every one of them', async () => {
    const a = await createSession();
    const b = await createSession();
    await closeSessionById(server!.core.accessor, a);
    await closeSessionById(server!.core.accessor, b);
    expect(getLiveSessionById(server!.core.accessor, a)).toBeUndefined();
    expect(getLiveSessionById(server!.core.accessor, b)).toBeUndefined();

    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli' }) });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    c.send({ type: 'subscribe', id: 's1', payload: { session_ids: [a, b, 'nope'] } });
    const ack = await c.next((f) => f.type === 'ack' && f.id === 's1');
    expect(ack.payload).toMatchObject({
      accepted: [a, b],
      not_found: ['nope'],
      resync_required: [],
      resumed: [a, b],
      failed: [],
    });
    expect(getLiveSessionById(server!.core.accessor, a)).toBeDefined();
    expect(getLiveSessionById(server!.core.accessor, b)).toBeDefined();

    await ensureMainAgent(a);
    await ensureMainAgent(b);
    emitAgentEvent(a, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);
    emitAgentEvent(b, { type: 'turn.started', turnId: 2 } as unknown as Event2<any>);
    const fromA = await c.next((f) => f.type === 'turn.started' && f.session_id === a);
    const fromB = await c.next((f) => f.type === 'turn.started' && f.session_id === b);
    expect(fromA.payload).toMatchObject({ turnId: 1 });
    expect(fromB.payload).toMatchObject({ turnId: 2 });

    const conns = await fetch(`${base}/api/v1/connections`, { headers: authHeaders(server as RunningServer) } as never);
    const listed = (await conns.json()) as { data: { connections: Array<{ subscriptions: string[] }> } };
    expect(listed.data.connections.some((item) => item.subscriptions.includes(a) && item.subscriptions.includes(b))).toBe(true);

    c.ws.close();
    await c.closed;
  });

  it('resumes cold sessions listed in client_hello subscriptions', async () => {
    const a = await createSession();
    await closeSessionById(server!.core.accessor, a);

    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [a, 'nope'] }) });
    const ack = await c.next((f) => f.type === 'ack' && f.id === 'h1');
    expect(ack.payload).toMatchObject({
      accepted_subscriptions: [a],
      resync_required: ['nope'],
      resumed: [a],
      failed: [],
    });
    expect(getLiveSessionById(server!.core.accessor, a)).toBeDefined();

    c.ws.close();
    await c.closed;
  });

  it('replays durable events since a cursor on reconnect', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);

    const c1 = await openConn(wsUrl, server!.authTokenService.getToken());
    await c1.next((f) => f.type === 'server_hello');
    c1.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c1.next((f) => f.type === 'ack' && f.id === 'h1');
    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);
    emitAgentEvent(sid, { type: 'turn.ended', turnId: 1 } as unknown as Event2<any>);
    await c1.next((f) => f.type === 'turn.ended');
    c1.ws.close();
    await c1.closed;

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

    const session = getLiveSessionById(server!.core.accessor, sid);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    await agents.create({ agentId: 'agent-0' });
    const sub = agents.handleOf('agent-0')!;

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

    agents.handleOf('main')!
      .accessor.get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 1 } as unknown as Event2<any>);
    sub.accessor
      .get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 2 } as unknown as Event2<any>);

    const ev = await c.next((f) => f.type === 'turn.ended');
    expect(ev.payload).toMatchObject({ agentId: 'main' });

    await expect(c.next((f) => f.type === 'turn.ended', 300)).rejects.toThrow();

    c.ws.close();
    await c.closed;
  });
});

describe('server-v2 /api/v1/ws live session quota', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-wsv1-quota-'));
    await writeFile(
      join(home, 'config.toml'),
      ['[server]', 'max_live_sessions = 1', 'session_idle_timeout_ms = 0', ''].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      sessionSweepIntervalMs: 20,
    });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function createSession(): Promise<{ id: string; workspaceId: string }> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string; workspace_id: string } };
    expect(body.code).toBe(0);
    return { id: body.data.id, workspaceId: body.data.workspace_id };
  }

  it('announces event.session.closed to subscribers when the quota evicts their session, and re-subscribing resumes it', async () => {
    const first = await createSession();
    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'cli', token: server!.authTokenService.getToken(), subscriptions: [first.id] },
    });
    const hello = await c.next((f) => f.type === 'ack' && f.id === 'h1');
    expect(hello.payload).toMatchObject({ accepted_subscriptions: [first.id] });

    const second = await createSession();
    c.send({ type: 'subscribe', id: 's1', payload: { session_ids: [second.id] } });
    await c.next((f) => f.type === 'ack' && f.id === 's1');

    const closed = await c.next((f) => f.type === 'event.session.closed', 5000);
    expect(closed.session_id).toBe('__global__');
    expect(closed.payload).toMatchObject({
      sessionId: first.id,
      workspace_id: first.workspaceId,
      reason: 'quota',
    });
    await vi.waitFor(() => expect(getLiveSessionById(server!.core.accessor, first.id)).toBeUndefined());

    const conns = await fetch(`${base}/api/v1/connections`, { headers: authHeaders(server as RunningServer) } as never);
    const listed = (await conns.json()) as { data: { connections: Array<{ subscriptions: string[] }> } };
    expect(listed.data.connections.some((item) => item.subscriptions.includes(first.id))).toBe(false);

    c.send({ type: 'subscribe', id: 's2', payload: { session_ids: [first.id] } });
    const again = await c.next((f) => f.type === 'ack' && f.id === 's2');
    expect(again.payload).toMatchObject({ accepted: [first.id], resumed: [first.id] });
    expect(getLiveSessionById(server!.core.accessor, first.id)).toBeDefined();

    c.ws.close();
    await c.closed;
  });
});
