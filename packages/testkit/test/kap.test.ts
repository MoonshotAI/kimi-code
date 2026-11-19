import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { WaitTimeoutError } from '#/errors';
import { isConversationFrame, turnsFromFrames, type KapFrame } from '#/kap/frames';
import { startKap, type KapRunningServer } from '#/kap/harness';
import { KapEnvelopeError, KapRest } from '#/kap/rest';
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
