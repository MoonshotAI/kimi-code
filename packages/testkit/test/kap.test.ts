import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { KapSchemaError, WaitTimeoutError } from '#/errors';
import { createTestHome, type TestHome } from '#/fixtures/home';
import { FIXED_TIME } from '#/fixtures/normalize';
import { KapClient } from '#/kap/client';
import { isConversationFrame, turnsFromFrames, type KapFrame, type KapTurn } from '#/kap/frames';
import { startKap, type KapRunningServer } from '#/kap/harness';
import { verifyKapInvariants } from '#/kap/invariants';
import { KapProcess } from '#/kap/process';
import { dropFrames, duplicateFrames, insertUnknownFrame, KapRecorder, mutateKapRecording, readKapRecording, replayKapRecording, UNKNOWN_FRAME_TYPE, type KapRecording } from '#/kap/recording';
import { KapEnvelopeError, KapRest, type KapExchange } from '#/kap/rest';
import { verifyKapSchemas } from '#/kap/schemas';
import { KapCommandError, KapSocket, WS_BEARER_PROTOCOL_PREFIX } from '#/kap/socket';

describe('turnsFromFrames', () => {
  const turn = (ordinal: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    turn_id: `t${ordinal}`,
    ordinal,
    status: 'running',
    items: [],
    ...extra,
  });

  it('applies live frames on top of the subscribe snapshot', () => {
    const frames: KapFrame[] = [
      { type: 'turns', turns: [turn(0, { status: 'ended', items: [{ item_id: 'u0', type: 'user_message', text: 'hi' }] })] },
      { type: 'turn.started', turn: turn(1) },
      { type: 'item.started', turn_id: 't1', item: { item_id: 'a1', type: 'assistant_message', text: '' } },
      { type: 'item.delta', turn_id: 't1', item_id: 'a1', field: 'text', delta: 'Hel' },
      { type: 'item.delta', turn_id: 't1', item_id: 'a1', field: 'text', delta: 'lo' },
      { type: 'item.started', turn_id: 't1', item: { item_id: 'c1', type: 'tool_call', status: 'running' } },
      { type: 'item.updated', turn_id: 't1', item_id: 'c1', set: { status: 'waiting' } },
      { type: 'turn.updated', turn_id: 't1', step: { index: 2, outcome: 'completed' } },
      { type: 'turn.updated', turn_id: 't1', step: { index: 1, outcome: 'completed' }, retry: { attempt: 1 } },
      { type: 'item.ended', turn_id: 't1', item: { item_id: 'a1', type: 'assistant_message', text: 'Hello', status: 'ended' } },
      { type: 'notice', turn_id: 't1', message: 'fyi' },
    ];
    const [first, running] = turnsFromFrames(frames);
    expect(first).toMatchObject({ turn_id: 't0', items: [{ item_id: 'u0', text: 'hi' }] });
    expect(running).toMatchObject({ turn_id: 't1', status: 'running', retry: { attempt: 1 } });
    expect(running?.items).toEqual([
      { item_id: 'a1', type: 'assistant_message', text: 'Hello', status: 'ended' },
      { item_id: 'c1', type: 'tool_call', status: 'waiting' },
    ]);
    expect(running?.['steps']).toEqual([
      { index: 1, outcome: 'completed' },
      { index: 2, outcome: 'completed' },
    ]);
    const ended = turnsFromFrames([...frames, { type: 'turn.ended', turn: turn(1, { status: 'ended', outcome: 'completed', steps: [{ index: 1 }] }) }])[1];
    expect(ended).toMatchObject({ status: 'ended', outcome: 'completed', steps: [{ index: 1 }] });
    expect(ended).not.toHaveProperty('retry');
    expect(ended?.items).toHaveLength(2);
  });

  it('clears a retry, removes items and turns, and keeps turns ordered', () => {
    const turns = turnsFromFrames([
      { type: 'turn.started', turn: turn(2) },
      { type: 'turn.started', turn: turn(1) },
      { type: 'turn.updated', turn_id: 't2', retry: { attempt: 1 } },
      { type: 'turn.updated', turn_id: 't2' },
      { type: 'item.started', turn_id: 't2', item: { item_id: 'x', type: 'assistant_message' } },
      { type: 'item.removed', turn_id: 't2', item_id: 'x' },
      { type: 'turn.started', turn: turn(3) },
      { type: 'turns.removed', turn_ids: ['t3'] },
      { type: 'turns.failed', turn_ids: ['t9'] },
    ]);
    expect(turns.map((entry) => entry.turn_id)).toEqual(['t1', 't2']);
    expect(turns[1]).not.toHaveProperty('retry');
    expect(turns[1]?.items).toEqual([]);
  });

  it('rejects conversation frames it does not understand', () => {
    expect(() => turnsFromFrames([{ type: 'turn.paused', turn_id: 't1' }])).toThrow(/Unknown KAP conversation frame type "turn.paused"/);
  });

  it('tells conversation frames from session frames', () => {
    expect(isConversationFrame({ type: 'item.delta', turn_id: 't1' })).toBe(true);
    expect(isConversationFrame({ type: 'turn.paused', turn_id: 't1' })).toBe(true);
    expect(isConversationFrame({ type: 'task', turn_id: 't1' })).toBe(false);
    expect(isConversationFrame({ type: 'todo' })).toBe(false);
  });
});

describe('KapRest', () => {
  interface Seen {
    readonly url: string;
    readonly init: RequestInit | undefined;
  }

  function restWith(status: number, body: string): { readonly rest: KapRest; readonly seen: Seen[] } {
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({ url: input instanceof Request ? input.url : String(input), init });
      return Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
    };
    return { rest: new KapRest('http://kap.test', () => 'tok', fetchImpl), seen };
  }

  it('sends bearer auth and query parameters and unwraps the envelope', async () => {
    const { rest, seen } = restWith(200, JSON.stringify({ code: 0, msg: 'ok', data: { id: 's1' } }));
    await expect(rest.get('/api/v1/sessions', { page_size: 2, before: undefined, archived: false })).resolves.toEqual({ id: 's1' });
    expect(seen[0]?.url).toBe('http://kap.test/api/v1/sessions?page_size=2&archived=false');
    expect(seen[0]?.init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok' } });
  });

  it('posts JSON bodies', async () => {
    const { rest, seen } = restWith(200, JSON.stringify({ code: 0, data: null }));
    await rest.post('/api/v1/sessions', { cwd: '/w' });
    expect(seen[0]?.init).toMatchObject({ method: 'POST', body: '{"cwd":"/w"}', headers: { 'content-type': 'application/json' } });
  });

  it('raises envelope errors with the method, path, status and code', async () => {
    const failing = restWith(404, JSON.stringify({ code: 40401, msg: 'session not found' }));
    await expect(failing.rest.get('/api/v1/sessions/x')).rejects.toMatchObject({
      name: 'KapEnvelopeError',
      method: 'GET',
      path: '/api/v1/sessions/x',
      status: 404,
      code: 40401,
    });
    const refused = restWith(200, JSON.stringify({ code: 1, msg: 'busy' }));
    await expect(refused.rest.post('/api/v1/sessions/x/prompts')).rejects.toBeInstanceOf(KapEnvelopeError);
    const garbled = restWith(502, '<html>bad gateway</html>');
    await expect(garbled.rest.get('/api/v1/sessions')).rejects.toThrow(/HTTP 502: "<html>bad gateway<\/html>"/);
  });

  it('records each response with its JSON body, including raw responses the caller reads itself', async () => {
    const exchanges: Promise<KapExchange>[] = [];
    const answers = [
      new Response(JSON.stringify({ code: 0, data: { id: 's1' } }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
      new Response('# KAP', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    ];
    const fetchImpl: typeof fetch = () => Promise.resolve(answers.shift() ?? new Response(null, { status: 500 }));
    const rest = new KapRest('http://kap.test', () => 'tok', fetchImpl, (exchange) => exchanges.push(exchange));
    await rest.post('/api/v1/sessions', { cwd: '/w' });
    await expect((await rest.raw('/api/v1/kap.md', { query: { lang: 'en' } })).text()).resolves.toBe('# KAP');
    await expect(Promise.all(exchanges)).resolves.toEqual([
      { method: 'POST', path: '/api/v1/sessions', status: 200, json: true, body: '{"code":0,"data":{"id":"s1"}}' },
      { method: 'GET', path: '/api/v1/kap.md', status: 200, json: false, body: undefined },
    ]);
  });
});

describe('KapSocket', () => {
  const servers: WebSocketServer[] = [];
  const sockets: KapSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => socket.close()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) client.terminate();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(onConnection: (peer: ServerSocket, protocol: string | undefined) => void): Promise<string> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    server.on('connection', (peer, request) => onConnection(peer, request.headers['sec-websocket-protocol']));
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ws`;
  }

  async function connect(url: string): Promise<KapSocket> {
    const socket = await KapSocket.connect(url, 'tok');
    sockets.push(socket);
    return socket;
  }

  function onJson(peer: ServerSocket, handler: (frame: Record<string, unknown>) => void): void {
    peer.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      handler(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>);
    });
  }

  it('authenticates with the bearer subprotocol and answers pings without recording them', async () => {
    let offered: string | undefined;
    const pongs: unknown[] = [];
    const url = await serve((peer, protocol) => {
      offered = protocol;
      onJson(peer, (frame) => pongs.push(frame));
      peer.send(JSON.stringify({ type: 'ping' }));
      peer.send(JSON.stringify({ type: 'hello' }));
    });
    const socket = await connect(url);
    await socket.waitFor((frame) => frame.type === 'hello');
    expect(offered).toBe(`${WS_BEARER_PROTOCOL_PREFIX}tok`);
    expect(socket.frames.map((frame) => frame.type)).toEqual(['hello']);
    await expect.poll(() => pongs).toEqual([{ type: 'pong' }]);
  });

  it('matches command responses by request id and raises failed commands', async () => {
    const url = await serve((peer) => {
      onJson(peer, (frame) => {
        if (frame['type'] !== 'subscribe') return;
        const failing = frame['session_id'] === 'missing';
        peer.send(JSON.stringify({ type: 'response', request_id: 'someone-else', code: 0 }));
        peer.send(JSON.stringify({ type: 'response', request_id: frame['request_id'], code: failing ? 40401 : 0 }));
        if (failing) return;
        for (const agentId of frame['agent_ids'] as string[]) {
          peer.send(JSON.stringify({ type: 'turns', session_id: frame['session_id'], agent_id: agentId, turns: [] }));
        }
      });
    });
    const socket = await connect(url);
    await socket.subscribe('s1', { agentIds: ['main', 'sub'] });
    expect(socket.frames.filter((frame) => frame.type === 'turns').map((frame) => frame['agent_id'])).toEqual(['main', 'sub']);
    await expect(socket.subscribe('missing')).rejects.toBeInstanceOf(KapCommandError);
  });

  it('waits for each newly subscribed agent and reloads its snapshot after unsubscribe', async () => {
    const subscribed = new Set<string>();
    const url = await serve((peer) => onJson(peer, (command) => {
      peer.send(JSON.stringify({ type: 'response', request_id: command['request_id'], code: 0 }));
      for (const agentId of command['agent_ids'] as string[]) {
        if (command['type'] === 'unsubscribe') {
          subscribed.delete(agentId);
        } else if (!subscribed.has(agentId)) {
          subscribed.add(agentId);
          peer.send(JSON.stringify({ type: 'turns', session_id: 's1', agent_id: agentId, turns: [] }));
        }
      }
    }));
    const socket = await connect(url);
    await socket.subscribe('s1', { waitForSnapshot: false });
    await socket.subscribe('s1');
    await socket.subscribe('s1', { agentIds: ['main', 'sub'] });
    await socket.subscribe('s1', { agentIds: ['sub', 'main'] });
    await socket.command({ type: 'unsubscribe', session_id: 's1', agent_ids: ['sub'] });
    await socket.subscribe('s1', { agentIds: ['main', 'sub'] });
    expect(socket.frames.filter((frame) => frame.type === 'turns').map((frame) => frame['agent_id'])).toEqual(['main', 'sub', 'sub']);
  });

  it('reports a failed snapshot with its agent, code and reason and allows another subscription', async () => {
    let attempts = 0;
    const url = await serve((peer) => onJson(peer, (command) => {
      attempts += 1;
      peer.send(JSON.stringify({ type: 'response', request_id: command['request_id'], code: 0 }));
      const snapshot = attempts === 1 ? { type: 'turns.failed', code: 40402, msg: 'history unavailable' } : { type: 'turns', turns: [] };
      peer.send(JSON.stringify({ ...snapshot, session_id: 's1', agent_id: 'child' }));
    }));
    const socket = await connect(url);
    const options = { agentIds: ['child'] };
    await expect(socket.subscribe('s1', options)).rejects.toMatchObject({
      name: 'KapCommandError',
      response: { type: 'turns.failed', session_id: 's1', agent_id: 'child', code: 40402, msg: 'history unavailable' },
    });
    await socket.subscribe('s1', options);
    expect(socket.frames.at(-1)).toMatchObject({ type: 'turns', agent_id: 'child' });
  });

  it.each([
    ['the session is archived', { type: 'session', change: 'archived', session: { id: 's1' } }],
    ['the session is deleted', { type: 'session', change: 'deleted', session: { id: 's1' } }],
    ['the agent ends', { type: 'agent', status: 'ended', session_id: 's1', agent_id: 'child' }],
  ] as const)('waits for a fresh snapshot after %s', async (_label, ended) => {
    let first = true;
    let peerSocket: ServerSocket | undefined;
    const url = await serve((peer) => {
      peerSocket = peer;
      onJson(peer, (command) => {
        peer.send(JSON.stringify({ type: 'response', request_id: command['request_id'], code: 0 }));
        if (command['type'] === 'subscribe' && first) {
          first = false;
          peer.send(JSON.stringify({ type: 'turns', session_id: 's1', agent_id: 'child', turns: [] }));
        }
      });
    });
    const socket = await connect(url);
    const options = { agentIds: ['child'] };
    await socket.subscribe('s1', options);
    peerSocket?.send(JSON.stringify(ended));
    await socket.waitFor((frame) => frame.type === ended.type);
    const snapshot = socket.subscribe('s1', options);
    await socket.command({ type: 'barrier' });
    peerSocket?.send(JSON.stringify({ type: 'turns.failed', session_id: 's1', agent_id: 'child', code: 40402, msg: 'agent removed' }));
    await expect(snapshot).rejects.toMatchObject({ response: { msg: 'agent removed' } });
  });

  it('explains a timed-out wait and fails fast once the server closes', async () => {
    let peerSocket: ServerSocket | undefined;
    const url = await serve((peer) => {
      peerSocket = peer;
      peer.send(JSON.stringify({ type: 'agent' }));
      peer.send('not json');
    });
    const socket = await connect(url);
    await expect(socket.waitFor((frame) => frame.type === 'never', { timeoutMs: 30 })).rejects.toThrow(WaitTimeoutError);
    await expect(socket.waitFor((frame) => frame.type === 'never', { timeoutMs: 30 })).rejects.toThrow(
      /received 1 frame\(s\), latest: agent; 1 unreadable frame\(s\), first: "not json"/,
    );
    const waiting = socket.waitFor((frame) => frame.type === 'never', { timeoutMs: 5_000 });
    peerSocket?.close(1001, 'idle');
    await expect(waiting).rejects.toThrow(/closed \(code 1001, reason "idle"\)/);
    expect(socket.unreadableFrames).toEqual(['not json']);
  });

  it('reports a refused upgrade with its HTTP status', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (_info, done) => done(false, 401) });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    await expect(KapSocket.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ws`, 'bad')).rejects.toThrow(
      /upgrade failed with HTTP 401/,
    );
  });
});

describe('KapHarness', () => {
  it('restores HOME when harnesses close in any order', async () => {
    const before = process.env['HOME'];
    const startServer = (): Promise<KapRunningServer> => Promise.resolve({ host: '127.0.0.1', port: 9, close: () => Promise.resolve() });
    const first = await startKap({ startServer });
    const second = await startKap({ startServer });
    expect(process.env['HOME']).toBe(second.home.home);
    await first.close();
    expect(process.env['HOME']).toBe(second.home.home);
    await second.close();
    expect(process.env['HOME']).toBe(before);
  });
});

describe('verifyKapInvariants', () => {
  interface StubKap {
    readonly session: Readonly<Record<string, unknown>>;
    readonly turns: readonly KapTurn[];
    readonly agents?: Readonly<Record<string, readonly KapTurn[]>>;
    readonly snapshot?: Readonly<Record<string, unknown>>;
    readonly frames?: readonly Readonly<Record<string, unknown>>[];
    readonly afterUnsubscribe?: readonly Readonly<Record<string, unknown>>[];
    readonly queued?: readonly unknown[];
    readonly deleted?: boolean;
    readonly broken?: boolean;
    readonly notFoundStatus?: number;
  }

  const idle = { id: 's1', activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'completed', archived: false };
  const header = { turn_id: 't1', ordinal: 0, kind: 'agent', status: 'ended', outcome: 'completed' };
  const reply = { item_id: 'a1', type: 'assistant_message', status: 'ended', outcome: 'completed', text: 'hi' };
  const answered: KapTurn = { ...header, items: [reply] };
  const live = (frame: Readonly<Record<string, unknown>>) => ({ session_id: 's1', agent_id: 'main', ...frame });
  const answeringFrames = [
    live({ type: 'turn.started', turn: { ...header, status: 'running', outcome: undefined } }),
    live({ type: 'item.ended', turn_id: 't1', item: reply }),
    live({ type: 'turn.ended', turn: header }),
  ];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  function send(peer: ServerSocket, frames: readonly Readonly<Record<string, unknown>>[]): void {
    for (const frame of frames) peer.send(JSON.stringify(frame));
  }

  async function stubKap(stub: StubKap, options: { readonly subscribe?: boolean; readonly agentIds?: readonly string[] } = {}): Promise<KapClient> {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://kap.test').pathname;
      const routes: Readonly<Record<string, unknown>> = {
        '/api/v1/sessions': stub.session,
        '/api/v1/sessions/s1': stub.session,
        '/api/v1/sessions/s1/prompts': { active: null, queued: stub.queued ?? [] },
        '/api/v1/sessions/s1/agents/main/turns': { turns: stub.turns, has_more: false },
        ...Object.fromEntries(Object.entries(stub.agents ?? {}).map(([agentId, turns]) => [`/api/v1/sessions/s1/agents/${agentId}/turns`, { turns, has_more: false }])),
      };
      const creating = path === '/api/v1/sessions';
      const found = creating || stub.deleted !== true ? routes[path] : undefined;
      const status = stub.broken === true && !creating ? 500 : found === undefined ? 404 : 200;
      response.writeHead(status === 404 ? (stub.notFoundStatus ?? 404) : status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { code: 0, data: found } : { code: status === 500 ? 50001 : 40401, msg: status === 500 ? 'internal error' : 'not found' }));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (peer) => {
      peer.on('message', (data) => {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        const command = JSON.parse(bytes.toString('utf8')) as Readonly<Record<string, unknown>>;
        peer.send(JSON.stringify({ type: 'response', request_id: command['request_id'], code: 0 }));
        if (command['type'] === 'unsubscribe') {
          send(peer, stub.afterUnsubscribe ?? []);
          return;
        }
        const agentIds = command['agent_ids'] as readonly string[];
        const snapshots = agentIds.map((agentId) => live({ type: 'turns', agent_id: agentId, turns: [], has_more: false, ...(agentId === 'main' ? stub.snapshot : {}) }));
        send(peer, [...snapshots, ...(stub.frames ?? [])]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new KapClient({ origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: () => 'tok' });
    closers.push(async () => {
      await Promise.all(client.connectedSockets.map((socket) => socket.close()));
      for (const peer of sockets.clients) peer.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await client.createSession();
    if (options.subscribe === false) return client;
    const socket = await client.connect();
    const agentIds = options.agentIds ?? ['main'];
    await socket.subscribe('s1', { agentIds });
    await socket.waitFor(() => socket.frames.length === 1 + agentIds.length + (stub.frames ?? []).length);
    return client;
  }

  it('passes when REST, the folded frames and the latest session frame agree', async () => {
    const client = await stubKap({
      session: idle,
      turns: [answered],
      frames: [
        ...answeringFrames,
        { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'pending' },
        { type: 'session', change: 'updated', session: { ...idle, activity: 'turn', pending_interaction: 'approval' } },
        { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'ended' },
        { type: 'session', change: 'updated', session: idle },
      ],
    });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('reports a session that is still busy and leaves its turns alone', async () => {
    const client = await stubKap({ session: { ...idle, activity: 'background' }, turns: [{ ...header, status: 'running', items: [] }], queued: [{}] }, { subscribe: false });
    await expect(verifyKapInvariants(client, { timeoutMs: 50 })).rejects.toMatchObject({
      name: 'KapInvariantError',
      problems: [expect.stringMatching(/^session s1 is still busy when the test ends \(activity background, pending interaction none, no running prompt, 1 queued prompt\(s\)\)/)],
    });
  });

  it('reports why it could not read a session instead of calling it busy', async () => {
    const client = await stubKap({ session: idle, turns: [], broken: true }, { subscribe: false });
    await expect(verifyKapInvariants(client, { timeoutMs: 50 })).rejects.toMatchObject({
      problems: [expect.stringMatching(/^could not read the state of session s1: KAP GET \/api\/v1\/sessions\/s1(\/prompts)? failed with HTTP 500 and code 50001/)],
    });
  });

  it('reports a turn and an item still running after the session went idle', async () => {
    const client = await stubKap({ session: idle, turns: [{ ...header, status: 'running', items: [{ ...reply, status: 'running' }] }] }, { subscribe: false });
    await expect(verifyKapInvariants(client)).rejects.toMatchObject({
      problems: [
        'turn t1 of agent main in session s1 is still running after the session went idle',
        'assistant_message item a1 in turn t1 of agent main in session s1 is still running after the session went idle',
      ],
    });
  });

  it('follows the agent references of tool calls to the turns of subagents', async () => {
    const delegation = { item_id: 'c1', type: 'tool_call', status: 'ended', outcome: 'completed', name: 'Agent', agent_refs: [{ agent_id: 'child', role: 'child' }] };
    const client = await stubKap(
      { session: idle, turns: [{ ...header, items: [delegation] }], agents: { child: [{ ...header, turn_id: 'c-t1', status: 'running', items: [] }] } },
      { subscribe: false },
    );
    await expect(verifyKapInvariants(client)).rejects.toMatchObject({
      problems: ['turn c-t1 of agent child in session s1 is still running after the session went idle'],
    });
  });

  it('reports a subscribed client whose frames fold into other turns than REST returns', async () => {
    const client = await stubKap({ session: idle, turns: [answered], frames: [answeringFrames[0]!, answeringFrames[2]!] });
    await expect(verifyKapInvariants(client, { timeoutMs: 50 })).rejects.toMatchObject({
      problems: ['client #1 subscribed to agent main of session s1 folds its frames into turns that differ from REST: turn t1: the client has 0 item(s), REST has 1'],
    });
  });

  it('compares a client that got a paged snapshot only with the turns from that page on', async () => {
    const earlier: KapTurn = { ...answered, turn_id: 't0', ordinal: 0 };
    const paged: KapTurn = { ...answered, ordinal: 1 };
    const client = await stubKap({ session: idle, turns: [earlier, paged], snapshot: { turns: [paged], has_more: true } });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('compares the stream of a subagent that ended with what REST returns for it', async () => {
    const child = (frame: Readonly<Record<string, unknown>>) => ({ ...live(frame), agent_id: 'child' });
    const childTurn: KapTurn = { ...answered, turn_id: 'c1' };
    const ended = child({ type: 'agent', status: 'ended' });
    const streamed = [child({ type: 'turn.started', turn: { ...header, turn_id: 'c1', status: 'running', outcome: undefined } }), child({ type: 'turn.ended', turn: { ...header, turn_id: 'c1' } })];
    const complete = await stubKap(
      { session: idle, turns: [], agents: { child: [childTurn] }, frames: [streamed[0]!, child({ type: 'item.ended', turn_id: 'c1', item: reply }), streamed[1]!, ended] },
      { agentIds: ['main', 'child'] },
    );
    await expect(verifyKapInvariants(complete)).resolves.toBeUndefined();
    const missingReply = await stubKap({ session: idle, turns: [], agents: { child: [childTurn] }, frames: [...streamed, ended] }, { agentIds: ['main', 'child'] });
    await expect(verifyKapInvariants(missingReply, { timeoutMs: 50 })).rejects.toMatchObject({
      problems: ['client #1 subscribed to agent child of session s1 folds its frames into turns that differ from REST: turn c1: the client has 0 item(s), REST has 1'],
    });
  });

  it('compares turns that started after a paged snapshot even when an undo gave them lower ordinals', async () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    const paged: KapTurn = { ...answered, turn_id: 't50', ordinal: 50, started_at: at(0) };
    const kept: KapTurn = { ...answered, turn_id: 't10', ordinal: 10, started_at: at(0) };
    const resent = { ...header, turn_id: 't11', ordinal: 11, started_at: at(2) };
    const client = await stubKap({
      session: idle,
      turns: [kept, { ...resent, items: [reply] }],
      snapshot: { turns: [paged], has_more: true, event_created_at: at(1) },
      frames: [
        live({ type: 'turns.removed', turn_ids: ['t50'] }),
        live({ type: 'turn.started', turn: { ...resent, status: 'running', outcome: undefined } }),
        live({ type: 'item.ended', turn_id: 't11', item: reply }),
        live({ type: 'turn.ended', turn: resent }),
      ],
    });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('reports a latest session frame that drops a field REST still has', async () => {
    const archived = { ...idle, archived: true };
    const { last_turn_outcome: _outcome, pending_interaction: _pending, ...withoutOutcome } = archived;
    const client = await stubKap({ session: archived, turns: [answered], frames: [...answeringFrames, { type: 'session', change: 'archived', session: withoutOutcome }] });
    await expect(verifyKapInvariants(client, { timeoutMs: 50 })).rejects.toMatchObject({
      problems: [
        `client #1's latest session frame for s1 says ${JSON.stringify({ activity: 'idle', pending_interaction: 'none', archived: true })}, but REST says ${JSON.stringify({ activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'completed', archived: true })}`,
      ],
    });
  });

  it('reads a session frame without a pending interaction as none, as archived frames send it', async () => {
    const archived = { ...idle, archived: true };
    const { pending_interaction: _pending, ...archivedFrame } = archived;
    const client = await stubKap({ session: archived, turns: [answered], frames: [...answeringFrames, { type: 'session', change: 'archived', session: archivedFrame }] });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('reports a session frame that says nothing is pending while an interaction the client was sent is still open', async () => {
    const client = await stubKap({
      session: idle,
      turns: [answered],
      frames: [
        ...answeringFrames,
        { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'pending' },
        { type: 'session', change: 'updated', session: { ...idle, activity: 'turn' } },
        { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'ended' },
        { type: 'session', change: 'updated', session: idle },
      ],
    });
    await expect(verifyKapInvariants(client)).rejects.toMatchObject({
      problems: [expect.stringMatching(/^client #1 received session frame #6 for s1 saying nothing is pending while interaction i1 was still pending/)],
    });
  });

  it('forgets the interactions of a session the client unsubscribed from', async () => {
    const client = await stubKap({
      session: idle,
      turns: [answered],
      frames: [...answeringFrames, { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'pending' }],
      afterUnsubscribe: [{ type: 'session', change: 'updated', session: idle }],
    });
    const [socket] = client.connectedSockets;
    await socket!.command({ type: 'unsubscribe', session_id: 's1', agent_ids: ['main'] });
    await socket!.waitFor((frame) => frame.type === 'session');
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('forgets the interactions of a session once the last subagent the client subscribed to ends', async () => {
    const child = (frame: Readonly<Record<string, unknown>>) => ({ ...live(frame), agent_id: 'child' });
    const client = await stubKap(
      {
        session: idle,
        turns: [],
        agents: { child: [] },
        frames: [
          { type: 'interaction', session_id: 's1', interaction_id: 'i1', status: 'pending' },
          child({ type: 'agent', status: 'ended' }),
          { type: 'session', change: 'updated', session: idle },
        ],
      },
      { agentIds: ['child'] },
    );
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('skips an agent that REST no longer knows, as a closed side agent answers with code 40401', async () => {
    const delegation = { item_id: 'c1', type: 'tool_call', status: 'ended', outcome: 'completed', name: 'Agent', agent_refs: [{ agent_id: 'closed', role: 'child' }] };
    const client = await stubKap({ session: idle, turns: [{ ...header, items: [delegation] }], notFoundStatus: 200 }, { subscribe: false });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });

  it('skips a session that no longer exists', async () => {
    const client = await stubKap({ session: idle, turns: [], deleted: true }, { subscribe: false });
    await expect(verifyKapInvariants(client)).resolves.toBeUndefined();
  });
});

describe('verifyKapSchemas', () => {
  interface StubAnswer {
    readonly status?: number;
    readonly contentType?: string;
    readonly body: unknown;
  }

  const json = (schema: Readonly<Record<string, unknown>>) => ({ content: { 'application/json': { schema } } });
  const envelope = (code: number, data: Readonly<Record<string, unknown>>) => ({
    type: 'object',
    additionalProperties: false,
    required: ['code', 'msg', 'data', 'request_id'],
    properties: { code: { type: 'number', enum: [code] }, msg: { type: 'string' }, request_id: { type: 'string' }, data },
  });
  const sessionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'created_at'],
    properties: { id: { type: 'string' }, created_at: { type: 'string' }, title: { type: 'string', nullable: true }, count: { type: 'integer', minimum: 0, exclusiveMinimum: true } },
  };
  const openapi = {
    openapi: '3.0.3',
    paths: {
      '/api/v1/sessions/{session_id}': {
        get: { responses: { '200': json({ oneOf: [envelope(0, sessionSchema), envelope(40401, { type: 'string', nullable: true, enum: [null] })] }) } },
      },
      '/api/v1/sessions/{session_id}:cancel': {
        post: { responses: { '200': json(envelope(0, { type: 'object', additionalProperties: false, required: ['cancelled'], properties: { cancelled: { type: 'boolean' } } })) } },
      },
      '/api/v1/kap.md': { get: { responses: { '200': { content: { 'text/markdown': { schema: { type: 'string' } } } } } } },
    },
  };
  const asyncapi = {
    asyncapi: '3.1.0',
    operations: {
      receiveClientMessages: { action: 'receive', messages: [{ $ref: '#/components/messages/subscribe' }] },
      sendServerMessages: { action: 'send', messages: [{ $ref: '#/components/messages/response' }, { $ref: '#/components/messages/item' }] },
    },
    components: {
      messages: {
        subscribe: { payload: { type: 'object', properties: { type: { type: 'string', const: 'subscribe' } } } },
        response: {
          payload: { type: 'object', required: ['type', 'request_id', 'code'], properties: { type: { type: 'string', const: 'response' }, request_id: { type: 'string' }, code: { type: 'integer' } } },
        },
        item: {
          payload: {
            type: 'object',
            required: ['type', 'item'],
            properties: {
              type: { type: 'string', enum: ['item.started', 'item.ended'] },
              item: {
                anyOf: [
                  { type: 'object', required: ['type', 'created_at'], properties: { type: { type: 'string', const: 'tool_call' }, created_at: { type: 'string' } } },
                  { type: 'object', required: ['type', 'text'], properties: { type: { type: 'string', const: 'assistant_message' }, text: { type: 'string' } } },
                ],
              },
            },
          },
        },
      },
    },
  };
  const ok = (data: unknown): StubAnswer => ({ body: { code: 0, msg: 'ok', data, request_id: 'r1' } });
  const done = { type: 'response', request_id: 'done', code: 0 };
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function stubKap(answers: Readonly<Record<string, StubAnswer>>, frames: readonly unknown[]): Promise<KapClient> {
    const routes: Readonly<Record<string, StubAnswer>> = { 'GET /openapi.json': { body: openapi }, 'GET /asyncapi.json': { body: asyncapi }, ...answers };
    const server = createServer((request, response) => {
      const answer = routes[`${request.method} ${new URL(request.url ?? '/', 'http://kap.test').pathname}`];
      if (answer === undefined) return response.writeHead(404).end();
      response.writeHead(answer.status ?? 200, { 'content-type': answer.contentType ?? 'application/json' });
      response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (peer) => {
      for (const frame of [...frames, done]) peer.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new KapClient({ origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: () => 'tok' });
    closers.push(async () => {
      await Promise.all(client.connectedSockets.map((socket) => socket.close()));
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const socket = await client.connect();
    await socket.waitFor((frame) => frame['request_id'] === 'done');
    return client;
  }

  async function problemsOf(client: KapClient): Promise<readonly string[]> {
    const error = await verifyKapSchemas(client).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(KapSchemaError);
    return (error as KapSchemaError).problems;
  }

  it('passes when every REST body and frame matches the published schema', async () => {
    const client = await stubKap(
      {
        'GET /api/v1/sessions/s1': ok({ id: 's1', created_at: FIXED_TIME, title: null, count: 1 }),
        'GET /api/v1/sessions/gone': { body: { code: 40401, msg: 'not found', data: null, request_id: 'r2' } },
        'POST /api/v1/sessions/s1:cancel': ok({ cancelled: true }),
        'GET /api/v1/kap.md': { contentType: 'text/markdown', body: '# KAP' },
      },
      [
        { type: 'item.ended', item: { type: 'tool_call', created_at: FIXED_TIME } },
        { type: 'item.started', item: { type: 'assistant_message', text: 'hi' } },
      ],
    );
    await client.rest.get('/api/v1/sessions/s1');
    await client.rest.raw('/api/v1/sessions/gone');
    await client.rest.post('/api/v1/sessions/s1:cancel');
    await client.rest.raw('/api/v1/kap.md');
    await expect(verifyKapSchemas(client)).resolves.toBeUndefined();
  });

  it('reports a missing required field once per kind, checked against the variant the message claims to be', async () => {
    const client = await stubKap({ 'GET /api/v1/sessions/s1': ok({ id: 's1' }) }, [
      { type: 'item.ended', item: { type: 'tool_call' } },
      { type: 'item.ended', item: { type: 'tool_call' } },
    ]);
    await client.rest.get('/api/v1/sessions/s1');
    await client.rest.get('/api/v1/sessions/s1');
    expect(await problemsOf(client)).toEqual([
      `GET /api/v1/sessions/{session_id} → HTTP 200: /data must have required property 'created_at'; first offending value: {"id":"s1"} (2 times)`,
      `WebSocket item.ended frame: /item must have required property 'created_at'; first offending value: {"type":"tool_call"} (2 times)`,
    ]);
  });

  it('reads OpenAPI 3.0 exclusive bounds and closed objects', async () => {
    const client = await stubKap({ 'GET /api/v1/sessions/s1': ok({ id: 's1', created_at: FIXED_TIME, count: 0, extra: true }) }, []);
    await client.rest.get('/api/v1/sessions/s1');
    expect(await problemsOf(client)).toEqual([
      `GET /api/v1/sessions/{session_id} → HTTP 200: /data must NOT have additional properties ("extra"); first offending value: {"id":"s1","created_at":"${FIXED_TIME}","count":0,"extra":true}`,
      'GET /api/v1/sessions/{session_id} → HTTP 200: /data/count must be > 0; first offending value: 0',
    ]);
  });

  it('reports routes, statuses and frames the contract does not declare', async () => {
    const client = await stubKap(
      {
        'GET /api/v1/unknown': ok({}),
        'POST /api/v1/sessions/s1:cancel': { status: 500, body: { code: 50001, msg: 'internal error', data: null, request_id: 'r3' } },
      },
      [{ type: 'mystery' }, 'not json'],
    );
    await client.rest.raw('/api/v1/unknown');
    await client.rest.raw('/api/v1/sessions/s1:cancel', { method: 'POST', body: {} });
    expect(await problemsOf(client)).toEqual([
      'GET /api/v1/unknown answered, but /openapi.json declares no such route',
      'POST /api/v1/sessions/{session_id}:cancel → HTTP 500: /openapi.json declares only HTTP 200 for this route; first offending value: {"code":50001,"msg":"internal error","data":null,"request_id":"r3"}',
      'client #1 received a WebSocket frame that is not a JSON object with a string type; first offending value: not json',
      'WebSocket frame type "mystery" is not a server message in /asyncapi.json; first offending value: {"type":"mystery"}',
    ]);
  });
});

const STUB_KAP_SERVER = `import { createServer } from 'node:http';
import { connect } from 'node:net';

const mode = process.env.STUB_MODE;
const token = 'stub-token';
if (mode === 'remote-ready') {
  console.log(JSON.stringify({ origin: 'http://192.0.2.1:80', ws_url: 'ws://192.0.2.1:80/api/v1/ws', token }));
  setInterval(() => {}, 60_000);
} else {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) return response.writeHead(401).end();
    if (request.method !== 'POST' || request.url !== '/api/v1/shutdown') return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 0, msg: 'ok', data: {} }), () => process.exit(0));
  });
  server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', async () => {
    if (mode === 'leaky') {
      await new Promise((resolve) => {
        connect({ host: 'blocked.example.test', port: 443, lookup: (_host, _options, callback) => callback(new Error('lookup disabled')) }).once('error', resolve);
      });
    }
    const { port } = server.address();
    console.log(JSON.stringify({ origin: 'http://127.0.0.1:' + port, ws_url: 'ws://127.0.0.1:' + port + '/api/v1/ws', token }));
  });
}
`;

describe('KapProcess', () => {
  const homes: TestHome[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => home.remove()));
  });

  async function startStub(mode: string): Promise<KapProcess> {
    const home = await createTestHome('testkit-kap-process');
    homes.push(home);
    const entry = join(home.root, 'stub-kap-server.mjs');
    await writeFile(entry, STUB_KAP_SERVER);
    return KapProcess.start({ home, command: { entry }, env: { STUB_MODE: mode } });
  }

  it('connects from the ready line and shuts the server down through the authenticated API', async () => {
    const server = await startStub('normal');
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.wsUrl).toBe(`${server.origin.replace('http', 'ws')}/api/v1/ws`);
    expect(server.token).toBe('stub-token');
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  }, 20_000);

  it('kills the process tree when a test simulates a crash', async () => {
    const server = await startStub('normal');
    await expect(server.crash()).resolves.toBeUndefined();
  }, 20_000);

  it('restarts on the same port, after a clean exit or a crash, until the test closes it', async () => {
    const server = await startStub('normal');
    const origin = server.origin;
    const pids = [server.pid];
    await server.restart();
    pids.push(server.pid);
    await server.restart('crash');
    pids.push(server.pid);
    expect(server.origin).toBe(origin);
    expect(new Set(pids).size).toBe(3);
    await server.close();
    await expect(server.restart()).rejects.toThrow('The KAP server was already stopped');
  }, 30_000);

  it('fails the shutdown when the server reached a non-loopback address', async () => {
    const server = await startStub('leaky');
    await expect(server.close()).rejects.toMatchObject({
      message: expect.stringContaining('Could not close the KAP server'),
      cause: expect.objectContaining({ message: expect.stringContaining('non-loopback addresses: blocked.example.test:443') }),
    });
  }, 20_000);

  it('refuses a ready line that points away from loopback and stops the child', async () => {
    await expect(startStub('remote-ready')).rejects.toMatchObject({
      message: expect.stringMatching(/^The KAP server failed to start\nKAP server pid=\d+ exit=null signal=SIGKILL|^The KAP server failed to start\nKAP server pid=\d+ exit=1/),
      cause: expect.objectContaining({ message: expect.stringContaining('does not describe a loopback server') }),
    });
  }, 20_000);
});

describe('KAP recordings', () => {
  const fakeSocket = (frames: KapFrame[]): KapSocket => ({ get frames() { return frames; }, mark: () => frames.length }) as unknown as KapSocket;
  const emptyPage = { turns: [], has_more: false };

  it('keeps one session and agent per stream and gives the same token to an ID in every stream', () => {
    const first: KapFrame[] = [{ type: 'turns', session_id: 's-1', agent_id: 'main', turns: [], has_more: false }];
    const second: KapFrame[] = [];
    const recorder = new KapRecorder('s-1');
    recorder.watch('primary', fakeSocket(first));
    recorder.watch('child', fakeSocket(first), 'subagent-1');
    expect(() => recorder.watch('primary', fakeSocket(second))).toThrow('already has a stream named primary');
    first.push(
      { type: 'turns', session_id: 's-1', agent_id: 'main', turns: [], has_more: false, event_created_at: '2026-11-19T08:00:00.000Z' },
      { type: 'turns', session_id: 's-2', agent_id: 'main', turns: [], has_more: false },
    );
    expect(recorder.checkpoint('subscribed')).toEqual({ primary: [expect.objectContaining({ type: 'turns' })], child: [] });
    recorder.watch('late', fakeSocket(second));
    first.push(
      { type: 'turn.started', session_id: 's-1', agent_id: 'main', turn: { turn_id: 't-9', ordinal: 0, items: [] } },
      { type: 'turn.started', session_id: 's-1', agent_id: 'subagent-1', turn: { turn_id: 't-10', ordinal: 0, items: [] } },
      { type: 'session.updated', session_id: 's-1', agent_id: 'main' },
    );
    second.push({ type: 'turns', session_id: 's-1', agent_id: 'main', turns: [{ turn_id: 't-9', ordinal: 0, items: [] }], has_more: false });
    recorder.checkpoint('started');
    const final = { turns: [{ turn_id: 't-9', ordinal: 0, items: [] }], has_more: false };
    expect(() => recorder.recording({ serverVersion: '1.0.0', kapVersion: '1', pages: { primary: { initial: emptyPage, final } } })).toThrow('no REST pages for stream child');
    const recording = recorder.recording({
      serverVersion: '1.0.0',
      kapVersion: '1',
      pages: { primary: { initial: emptyPage, final }, child: { initial: emptyPage, final: emptyPage }, late: { initial: emptyPage, final } },
    });
    const shape = Object.fromEntries(Object.entries(recording.streams).map(([name, stream]) => [name, stream.checkpoints.map(({ name: at, frames }) => [at, frames.map((frame) => frame.type)])]));
    expect(shape).toEqual({
      primary: [['subscribed', ['turns']], ['started', ['turn.started']]],
      child: [['subscribed', []], ['started', ['turn.started']]],
      late: [['started', ['turns']]],
    });
    expect(recording.streams['primary']?.checkpoints[0]?.frames[0]).toMatchObject({ session_id: '<session_id:1>', event_created_at: FIXED_TIME });
    expect(recording.streams['primary']?.checkpoints[1]?.frames[0]?.['turn']).toMatchObject({ turn_id: '<turn_id:1>' });
    expect(recording.streams['child']?.checkpoints[1]?.frames[0]?.['turn']).toMatchObject({ turn_id: '<turn_id:2>' });
    expect(recording.streams['late']?.checkpoints[0]?.frames[0]?.['turns']).toEqual([expect.objectContaining({ turn_id: '<turn_id:1>' })]);
    expect(recording.streams['late']?.final.turns[0]).toMatchObject({ turn_id: '<turn_id:1>' });
    expect(recording.streams['child']?.agentId).toBe('subagent-1');
    expect(() => new KapRecorder('s-1').checkpoint('empty')).toThrow('Watch at least one socket');
  });

  it('replays each stream in order and refuses recordings it cannot read', async () => {
    const home = await createTestHome('testkit-recording');
    try {
      const recording: KapRecording = {
        format: 2,
        serverVersion: '1.0.0',
        kapVersion: '1',
        streams: {
          primary: {
            agentId: 'main',
            initial: emptyPage,
            checkpoints: [
              { name: 'first', frames: [{ type: 'turn.started' }] },
              { name: 'second', frames: [{ type: 'item.started' }, { type: 'turn.ended' }] },
            ],
            final: emptyPage,
          },
        },
      };
      const path = join(home.root, 'trace.json');
      await writeFile(path, JSON.stringify(recording));
      const typesSeen = { start: (page: { turns: readonly unknown[] }) => [`start:${page.turns.length}`], apply: (seen: string[], frame: KapFrame) => [...seen, frame.type] };
      expect(replayKapRecording(await readKapRecording(path), 'primary', typesSeen)).toEqual([
        { name: 'first', view: ['start:0', 'turn.started'] },
        { name: 'second', view: ['start:0', 'turn.started', 'item.started', 'turn.ended'] },
      ]);
      expect(() => replayKapRecording(recording, 'late', typesSeen)).toThrow('has no stream named late; it has primary');
      await writeFile(path, JSON.stringify({ ...recording, format: 1 }));
      await expect(readKapRecording(path)).rejects.toThrow(/uses KAP recording format 1; this testkit reads format 2/);
      await writeFile(path, JSON.stringify({ ...recording, streams: { primary: { ...recording.streams['primary'], checkpoints: [{ name: 'broken' }] } } }));
      await expect(readKapRecording(path)).rejects.toThrow(/is not a complete KAP recording/);
      await writeFile(path, JSON.stringify({ ...recording, streams: {} }));
      await expect(readKapRecording(path)).rejects.toThrow(/is not a complete KAP recording/);
    } finally {
      await home.remove();
    }
  });

  it('drops, duplicates and adds frames in one checkpoint of one stream', () => {
    const frames: KapFrame[] = [
      { type: 'item.started', session_id: '<session_id:1>', agent_id: 'main' },
      { type: 'item.delta', session_id: '<session_id:1>', agent_id: 'main' },
      { type: 'turn.ended', session_id: '<session_id:1>', agent_id: 'main' },
    ];
    const recording: KapRecording = {
      format: 2,
      serverVersion: '1.0.0',
      kapVersion: '1',
      streams: { primary: { agentId: 'main', initial: emptyPage, checkpoints: [{ name: 'partial', frames }, { name: 'completed', frames }], final: emptyPage } },
    };
    const at = { stream: 'primary', checkpoint: 'partial' };
    const typesAt = (changed: KapRecording, checkpoint: number) => changed.streams['primary']!.checkpoints[checkpoint]!.frames.map((frame) => frame.type);
    expect(typesAt(mutateKapRecording(recording, at, dropFrames((frame) => frame.type === 'item.delta')), 0)).toEqual(['item.started', 'turn.ended']);
    expect(typesAt(mutateKapRecording(recording, at, duplicateFrames((frame) => frame.type === 'item.delta')), 0)).toEqual(['item.started', 'item.delta', 'item.delta', 'turn.ended']);
    const withUnknown = mutateKapRecording(recording, at, insertUnknownFrame(1));
    expect(typesAt(withUnknown, 0)).toEqual(['item.started', UNKNOWN_FRAME_TYPE, 'item.delta', 'turn.ended']);
    expect(withUnknown.streams['primary']!.checkpoints[0]!.frames[1]).toEqual({ type: UNKNOWN_FRAME_TYPE, session_id: '<session_id:1>', agent_id: 'main' });
    expect(typesAt(withUnknown, 1)).toEqual(['item.started', 'item.delta', 'turn.ended']);
    expect(recording.streams['primary']!.checkpoints[0]!.frames).toHaveLength(3);
    expect(() => mutateKapRecording(recording, at, dropFrames((frame) => frame.type === 'notice'))).toThrow('dropFrames matched no frame');
    expect(() => mutateKapRecording(recording, at, duplicateFrames(() => false))).toThrow('duplicateFrames matched no frame');
    expect(() => mutateKapRecording(recording, at, insertUnknownFrame(4))).toThrow('outside 0..3');
    expect(() => mutateKapRecording(recording, { stream: 'primary', checkpoint: 'later' }, insertUnknownFrame(0))).toThrow('no checkpoint named later');
  });
});
