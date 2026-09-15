import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IDisposable, Workspace } from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
import type { ServerMessage, WorkspaceInfo } from '../src/protocol/messages';
import { startServer, type RunningServer } from '../src/start';
import { WsConnectionDebug } from '../src/transport/ws/debug/wsConnectionDebug';
import {
  WsConnectionV3,
  type WsConnectionV3Options,
} from '../src/transport/ws/v3/wsConnectionV3';
import type { WsV3CoreEvent, WsV3Logger } from '../src/transport/ws/v3/wsV3Deps';
import { WsV3Hub } from '../src/transport/ws/v3/wsV3Hub';
import { authHeaders } from './helpers/auth';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const TS = '2026-01-01T00:00:00.000Z';
const WS_ID = 'wd_test_0123456789ab';

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminateCalls = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  emit(event: string, ...a: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...a);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakeProjection {
  readonly live = new Set<string>();
  readonly recovery = new Map<string, ServerMessage[]>();
  readonly listeners = new Map<string, Set<(message: ServerMessage) => void>>();

  onMessage(
    sessionId: string,
    listener: (message: ServerMessage) => void,
  ): IDisposable | undefined {
    if (!this.live.has(sessionId)) return undefined;
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  recoveryMessages(sessionId: string): ServerMessage[] {
    return this.recovery.get(sessionId) ?? [];
  }

  emit(sessionId: string, message: ServerMessage): void {
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener(message);
  }
}

class FakeLifecycle {
  readonly existing = new Set<string>();
  private readonly cbs = new Set<(event: { sessionId: string }) => void>();

  onDidCreateSession(cb: (event: { sessionId: string }) => void): IDisposable {
    this.cbs.add(cb);
    return {
      dispose: () => {
        this.cbs.delete(cb);
      },
    };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.existing.has(sessionId);
  }

  fireCreated(sessionId: string): void {
    for (const cb of [...this.cbs]) cb({ sessionId });
  }
}

class FakeGlobalSource {
  workspaces: Workspace[] = [];
  sessionInfoResult: unknown;
  private readonly cbs = new Set<(event: WsV3CoreEvent) => void>();
  private readonly activityCbs = new Set<(sessionId: string) => void>();

  subscribe(cb: (event: WsV3CoreEvent) => void): IDisposable {
    this.cbs.add(cb);
    return {
      dispose: () => {
        this.cbs.delete(cb);
      },
    };
  }

  fire(event: WsV3CoreEvent): void {
    for (const cb of [...this.cbs]) cb(event);
  }

  watchSessionActivity(cb: (sessionId: string) => void): IDisposable {
    this.activityCbs.add(cb);
    return {
      dispose: () => {
        this.activityCbs.delete(cb);
      },
    };
  }

  fireActivity(sessionId: string): void {
    for (const cb of [...this.activityCbs]) cb(sessionId);
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    return this.workspaces;
  }

  async workspaceInfo(workspace: Workspace): Promise<WorkspaceInfo> {
    return {
      id: workspace.id,
      root: workspace.root,
      name: workspace.name,
      created_at: new Date(workspace.createdAt).toISOString(),
      last_opened_at: new Date(workspace.lastOpenedAt).toISOString(),
      session_count: 0,
    };
  }

  async sessionInfo(): Promise<unknown> {
    return this.sessionInfoResult;
  }
}

interface Harness {
  projection: FakeProjection;
  lifecycle: FakeLifecycle;
  globalSource: FakeGlobalSource;
  hub: WsV3Hub;
  logger: WsV3Logger;
  warnings: string[];
}

function makeHarness(): Harness {
  const projection = new FakeProjection();
  const lifecycle = new FakeLifecycle();
  const globalSource = new FakeGlobalSource();
  const warnings: string[] = [];
  const logger: WsV3Logger = {
    warn: (_obj, msg) => {
      warnings.push(msg);
    },
  };
  const hub = new WsV3Hub({ projection, lifecycle, globalSource, logger });
  return { projection, lifecycle, globalSource, hub, logger, warnings };
}

function makeConn(
  hub: WsV3Hub,
  socket: FakeSocket,
  opts: Partial<WsConnectionV3Options> = {},
): WsConnectionV3 {
  return new WsConnectionV3({
    socket: socket as unknown as WebSocket,
    hub,
    remoteAddress: null,
    userAgent: null,
    ...opts,
  });
}

async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function sessionStateMessage(sessionId: string): ServerMessage {
  return {
    type: 'session.state',
    session_id: sessionId,
    event_created_at: TS,
    status: 'idle',
  };
}

function assistantMessage(sessionId: string, agentId: string, text = 'hello'): ServerMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    agent_id: agentId,
    event_created_at: TS,
    message_id: `t1.1.a0.${agentId}.${text}`,
    turn_id: 't1',
    step_id: 't1.1',
    status: 'streaming',
    text,
  };
}

function assistantDeltaMessage(sessionId: string, agentId: string): ServerMessage {
  return {
    type: 'assistant.delta',
    session_id: sessionId,
    agent_id: agentId,
    event_created_at: TS,
    message_id: `t1.1.a0.${agentId}.delta`,
    text: 'chunk',
  };
}

function sessionInfoWire(id: string): Record<string, unknown> {
  return {
    id,
    workspace_id: WS_ID,
    title: 'session title',
    created_at: TS,
    updated_at: TS,
    busy: false,
    metadata: { cwd: '/tmp' },
    agent_config: { model: 'model-x' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      context_tokens: 0,
    },
    permission_rules: [],
    message_count: 0,
  };
}

function frameTypes(socket: FakeSocket): unknown[] {
  return socket.frames().map((frame) => frame['type']);
}

describe('WsConnectionV3 subscribe and recovery', () => {
  it('sends no handshake frame and answers ping with a response echoing the request id', () => {
    const { hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);
    expect(socket.frames()).toEqual([]);

    socket.emit('message', JSON.stringify({ type: 'ping', request_id: 'req-1' }));
    expect(socket.frames()).toEqual([{ type: 'response', request_id: 'req-1', code: ErrorCode.SUCCESS }]);
  });

  it('responds to subscribe and delivers recovery before live messages in one session sequence', async () => {
    const { projection, lifecycle, hub, logger, warnings } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recovery.set('s1', [sessionStateMessage('s1'), assistantMessage('s1', 'main')]);
    const socket = new FakeSocket();
    makeConn(hub, socket, { logger });

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r7', session_id: 's1' }));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant']);
    expect(socket.frames()[0]).toEqual({ type: 'response', request_id: 'r7', code: ErrorCode.SUCCESS });

    projection.emit('s1', assistantMessage('s1', 'main', 'live'));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant', 'assistant']);
    expect(socket.frames()[3]).toMatchObject({ text: 'live' });

    projection.emit('s1', { type: 'assistant', session_id: 's1' } as ServerMessage);
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant', 'assistant']);
    expect(warnings.some((msg) => msg.includes('failed schema validation'))).toBe(true);
  });

  it('responds SESSION_NOT_FOUND when subscribing to an unknown session', async () => {
    const { hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r3', session_id: 'ghost' }));
    await settle();
    expect(socket.frames()[0]).toMatchObject({
      type: 'response',
      request_id: 'r3',
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it('replies error for unknown frame types and malformed JSON', () => {
    const { hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'bogus_frame', request_id: 'r1' }));
    socket.emit('message', 'not json at all');
    expect(socket.frames()[0]).toMatchObject({
      type: 'error',
      code: ErrorCode.VALIDATION_FAILED,
    });
    expect(socket.frames()[1]).toMatchObject({
      type: 'error',
      code: ErrorCode.REQUEST_MALFORMED,
    });
  });

  it('filters recovery and live messages by agent_ids and omit at the fanout point', async () => {
    const { projection, lifecycle, hub } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recovery.set('s1', [
      sessionStateMessage('s1'),
      assistantMessage('s1', 'main'),
      assistantMessage('s1', 'sub'),
    ]);
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'subscribe',
        request_id: 'r1',
        session_id: 's1',
        agent_ids: ['main'],
        omit: ['assistant.delta'],
      }),
    );
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant']);

    projection.emit('s1', assistantMessage('s1', 'sub', 'filtered'));
    projection.emit('s1', assistantDeltaMessage('s1', 'main'));
    projection.emit('s1', assistantMessage('s1', 'main', 'kept'));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant', 'assistant']);
    expect(socket.frames()[3]).toMatchObject({ text: 'kept' });
  });

  it('responds to unsubscribe and stops further delivery', async () => {
    const { projection, lifecycle, hub } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recovery.set('s1', [sessionStateMessage('s1')]);
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 's1' }));
    await settle();
    socket.emit('message', JSON.stringify({ type: 'unsubscribe', request_id: 'r2', session_id: 's1' }));
    await settle();
    expect(socket.frames()[2]).toEqual({ type: 'response', request_id: 'r2', code: ErrorCode.SUCCESS });

    projection.emit('s1', assistantMessage('s1', 'main', 'late'));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'response']);
  });

  it('disposes the lane listener on disconnect and delivers recovery again on a fresh resubscribe', async () => {
    const { projection, lifecycle, hub } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recovery.set('s1', [sessionStateMessage('s1')]);

    const first = new FakeSocket();
    makeConn(hub, first);
    first.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 's1' }));
    await settle();
    expect(frameTypes(first)).toEqual(['response', 'session.state']);
    expect(projection.listeners.get('s1')?.size).toBe(1);

    first.close();
    await settle();
    expect(projection.listeners.get('s1')?.size ?? 0).toBe(0);
    projection.emit('s1', assistantMessage('s1', 'main', 'late'));
    await settle();
    expect(frameTypes(first)).toEqual(['response', 'session.state']);

    const second = new FakeSocket();
    makeConn(hub, second);
    second.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 's1' }));
    await settle();
    expect(frameTypes(second)).toEqual(['response', 'session.state']);
  });

  it('replaces the subscription when the same session is subscribed again', async () => {
    const { projection, lifecycle, hub } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recovery.set('s1', [sessionStateMessage('s1')]);
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 's1' }));
    await settle();
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', request_id: 'r2', session_id: 's1', agent_ids: ['sub'] }),
    );
    await settle();
    expect(frameTypes(socket)).toEqual([
      'response',
      'session.state',
      'response',
      'session.state',
    ]);
    expect(socket.frames()[2]).toEqual({ type: 'response', request_id: 'r2', code: ErrorCode.SUCCESS });

    projection.emit('s1', assistantMessage('s1', 'main', 'filtered'));
    projection.emit('s1', assistantMessage('s1', 'sub', 'kept'));
    await settle();
    expect(frameTypes(socket)).toEqual([
      'response',
      'session.state',
      'response',
      'session.state',
      'assistant',
    ]);
    expect(socket.frames()[4]).toMatchObject({ text: 'kept' });
  });

  it('serves a minimal recovery for non-live sessions and backfills one when the session becomes live', async () => {
    const { projection, lifecycle, hub } = makeHarness();
    lifecycle.existing.add('s2');
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: 's2' }));
    await settle();
    expect(frameTypes(socket)).toEqual(['response']);
    expect(socket.frames()[0]).toMatchObject({ code: ErrorCode.SUCCESS });

    projection.live.add('s2');
    projection.recovery.set('s2', [sessionStateMessage('s2')]);
    lifecycle.fireCreated('s2');
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state']);

    projection.emit('s2', assistantMessage('s2', 'main', 'after'));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'session.state', 'assistant']);
  });

  it('responds INTERNAL_ERROR and keeps live traffic flowing when the recovery payload throws', async () => {
    const { projection, lifecycle, hub, warnings } = makeHarness();
    lifecycle.existing.add('s1');
    projection.live.add('s1');
    projection.recoveryMessages = () => {
      throw new Error('recovery boom');
    };
    const socket = new FakeSocket();
    makeConn(hub, socket);

    socket.emit('message', JSON.stringify({ type: 'subscribe', request_id: 'r9', session_id: 's1' }));
    await settle();
    expect(socket.frames()[0]).toEqual({ type: 'response', request_id: 'r9', code: ErrorCode.SUCCESS });
    expect(socket.frames()[1]).toMatchObject({ type: 'response', request_id: 'r9', code: ErrorCode.INTERNAL_ERROR });
    expect(warnings.some((msg) => msg.includes('recovery failed'))).toBe(true);

    projection.emit('s1', assistantMessage('s1', 'main', 'after'));
    await settle();
    expect(frameTypes(socket)).toEqual(['response', 'response', 'assistant']);
    expect(socket.frames()[2]).toMatchObject({ text: 'after' });
  });
});

describe('WsConnectionV3 backpressure', () => {
  it('closes slow consumers with a dedicated error code when the outbound queue overflows', () => {
    const { hub } = makeHarness();
    const socket = new FakeSocket();
    socket.bufferedAmount = 1 << 21;
    const conn = makeConn(hub, socket, { maxOutboundMessages: 3 });

    for (let i = 0; i < 4; i++) conn.enqueue(sessionStateMessage('s1'));

    expect(socket.frames()[0]).toEqual({
      type: 'error',
      code: ErrorCode.WS_SLOW_CONSUMER,
      msg: 'outbound queue overflow: slow consumer',
    });
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'slow consumer' }]);
  });

  it('overflows a stalled queue that never drains within the stall timeout', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHarness();
      const socket = new FakeSocket();
      socket.bufferedAmount = 1 << 21;
      const conn = makeConn(hub, socket, {
        maxOutboundMessages: 100,
        stallTimeoutMs: 50,
        backpressureRetryMs: 5,
      });
      conn.enqueue(sessionStateMessage('s1'));
      vi.advanceTimersByTime(200);
      expect(socket.frames()[0]).toMatchObject({
        type: 'error',
        code: ErrorCode.WS_SLOW_CONSUMER,
      });
      expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'slow consumer' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsConnectionV3 inbound idle timeout', () => {
  it('terminates the connection when no inbound frame arrives within the idle timeout', () => {
    vi.useFakeTimers();
    try {
      const { hub, logger, warnings } = makeHarness();
      const socket = new FakeSocket();
      makeConn(hub, socket, { logger, idleTimeoutMs: 100 });

      vi.advanceTimersByTime(100);
      expect(socket.terminateCalls).toBe(0);
      vi.advanceTimersByTime(100);
      expect(socket.terminateCalls).toBe(1);
      expect(warnings.some((msg) => msg.includes('inbound idle timeout'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the connection alive while inbound frames arrive', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHarness();
      const socket = new FakeSocket();
      makeConn(hub, socket, { idleTimeoutMs: 100 });

      vi.advanceTimersByTime(50);
      socket.emit('message', JSON.stringify({ type: 'ping', request_id: 'r1' }));
      vi.advanceTimersByTime(50);
      expect(socket.terminateCalls).toBe(0);
      vi.advanceTimersByTime(50);
      socket.emit('message', JSON.stringify({ type: 'ping', request_id: 'r2' }));
      vi.advanceTimersByTime(100);
      expect(socket.terminateCalls).toBe(0);
      vi.advanceTimersByTime(150);
      expect(socket.terminateCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsConnectionDebug inbound idle timeout', () => {
  it('closes an idle debug connection but tolerates inbound frames', () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      new WsConnectionDebug({ socket: socket as unknown as WebSocket, idleTimeoutMs: 100 });

      vi.advanceTimersByTime(50);
      socket.emit('message', JSON.stringify({ type: 'subscribe' }));
      vi.advanceTimersByTime(50);
      expect(socket.closeCalls).toEqual([]);
      vi.advanceTimersByTime(150);
      expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsV3 global message fanout', () => {
  it('translates config, capability, plugin and catalog events into global messages', async () => {
    const { globalSource, hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);
    await settle();

    globalSource.fire({
      type: 'event.config.warning',
      payload: { warnings: [{ domain: 'model', message: 'bad field' }, { message: 'plain' }] },
    });
    globalSource.fire({
      type: 'event.config.changed',
      payload: { changedFields: ['default_model'], config: { default_model: 'm2' } },
    });
    globalSource.fire({
      type: 'event.capability.changed',
      payload: { capability_id: 'cap-1', install: { running: true } },
    });
    globalSource.fire({ type: 'event.plugin.changed', payload: {} });
    globalSource.fire({ type: 'event.model_catalog.changed', payload: { changed: [] } });
    await settle();

    const frames = socket.frames();
    expect(frames[0]).toEqual({
      type: 'config.warning',
      event_created_at: expect.any(String),
      warnings: ['model: bad field', 'plain'],
    });
    expect(frames[1]).toEqual({
      type: 'config',
      event_created_at: expect.any(String),
      config: { default_model: 'm2' },
      changed_fields: ['default_model'],
    });
    expect(frames[2]).toEqual({
      type: 'capability',
      event_created_at: expect.any(String),
      capability_id: 'cap-1',
    });
    expect(frames[3]).toEqual({ type: 'plugin', event_created_at: expect.any(String) });
    expect(frames[4]).toEqual({ type: 'model_catalog', event_created_at: expect.any(String) });
  });

  it('translates workspace and session lifecycle events into global messages', async () => {
    const { globalSource, hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);
    await settle();

    const workspace = {
      id: WS_ID,
      root: '/tmp/ws-root',
      name: 'ws-root',
      createdAt: 1_700_000_000_000,
      lastOpenedAt: 1_700_000_100_000,
    };
    globalSource.fire({ type: 'event.workspace.created', payload: { workspace } });
    globalSource.fire({
      type: 'event.workspace.deleted',
      payload: { workspaceId: WS_ID, root: '/tmp/ws-root' },
    });
    globalSource.fire({
      type: 'event.workspace.deleted',
      payload: { workspaceId: 'wd_gone_0123456789ab', root: '/tmp/gone-dir' },
    });
    await settle();

    const frames = socket.frames();
    expect(frames[0]).toMatchObject({
      type: 'workspace',
      subtype: 'created',
      workspace: { id: WS_ID, name: 'ws-root', session_count: 0 },
    });
    expect(frames[1]).toMatchObject({
      type: 'workspace',
      subtype: 'deleted',
      workspace: { id: WS_ID, name: 'ws-root' },
    });
    expect(frames[2]).toMatchObject({
      type: 'workspace',
      subtype: 'deleted',
      workspace: { id: 'wd_gone_0123456789ab', name: 'gone-dir', session_count: 0 },
    });

    globalSource.sessionInfoResult = sessionInfoWire('s1');
    globalSource.fire({
      type: 'event.session.created',
      payload: { sessionId: 's1', session: sessionInfoWire('s1') },
    });
    globalSource.fire({
      type: 'session.meta.updated',
      payload: { sessionId: 's1', patch: { title: 'new title' } },
    });
    globalSource.fire({
      type: 'event.session.archived',
      payload: { sessionId: 's1', workspaceId: WS_ID },
    });
    await settle();

    const sessionFrames = socket.frames();
    expect(sessionFrames[3]).toMatchObject({
      type: 'session',
      subtype: 'created',
      session: { id: 's1' },
    });
    expect(sessionFrames[4]).toMatchObject({
      type: 'session',
      subtype: 'updated',
      session: { id: 's1' },
      changed_fields: ['title'],
    });
    expect(sessionFrames[5]).toMatchObject({
      type: 'session',
      subtype: 'archived',
      session: { id: 's1' },
    });
  });

  it('emits session updated on activity and session deleted only for sessions seen before', async () => {
    const { globalSource, hub } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);
    await settle();

    globalSource.sessionInfoResult = sessionInfoWire('s1');
    globalSource.fire({
      type: 'event.session.created',
      payload: { sessionId: 's1', session: sessionInfoWire('s1') },
    });
    globalSource.fireActivity('s1');
    await settle();

    const frames = socket.frames();
    expect(frames[1]).toMatchObject({
      type: 'session',
      subtype: 'updated',
      session: { id: 's1' },
    });

    globalSource.sessionInfoResult = undefined;
    globalSource.fireActivity('s9');
    await settle();
    expect(socket.frames()).toHaveLength(2);

    globalSource.fire({
      type: 'event.session.deleted',
      payload: { sessionId: 's1', workspaceId: WS_ID },
    });
    globalSource.fire({
      type: 'event.session.deleted',
      payload: { sessionId: 's2', workspaceId: WS_ID },
    });
    await settle();
    expect(socket.frames()).toHaveLength(3);
    expect(socket.frames()[2]).toMatchObject({
      type: 'session',
      subtype: 'deleted',
      session: { id: 's1' },
    });
  });

  it('drops global messages that fail outbound schema validation and logs telemetry', async () => {
    const { globalSource, hub, warnings } = makeHarness();
    const socket = new FakeSocket();
    makeConn(hub, socket);
    await settle();

    globalSource.fire({
      type: 'event.session.created',
      payload: { sessionId: 's1', session: { id: 's1' } },
    });
    await settle();
    expect(frameTypes(socket)).toEqual([]);
    expect(warnings.some((msg) => msg.includes('failed schema validation'))).toBe(true);

    globalSource.fire({
      type: 'event.session.created',
      payload: { sessionId: 's2', session: { id: 's2' } },
    });
    await settle();
    expect(frameTypes(socket)).toEqual([]);
    expect(warnings.filter((msg) => msg.includes('failed schema validation'))).toHaveLength(1);
  });
});

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

describe('WsV3 endpoint over a real server', () => {
  let home: string;
  let server: RunningServer;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v3-ws-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth('v3-token'),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
  });

  function v3Url(): string {
    return `${base.replace(/^http/, 'ws')}/api/v3/ws`;
  }

  function openV3(): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(v3Url(), { headers: authHeaders(server) });
      const frames: Array<Record<string, unknown>> = [];
      ws.on('message', (data: RawData) => {
        try {
          frames.push(JSON.parse(rawToString(data)) as Record<string, unknown>);
        } catch {
        }
      });
      ws.once('open', () => resolve({ ws, frames }));
      ws.once('error', reject);
    });
  }

  function expectRejected(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const done = (err?: Error): void => {
        clearTimeout(timer);
        ws.removeAllListeners();
        try {
          ws.terminate();
        } catch {
        }
        if (err !== undefined) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error('connection was not rejected')), 1500);
      ws.once('open', () => done(new Error('connection unexpectedly opened')));
      ws.once('error', () => done());
      ws.once('close', () => done());
    });
  }

  it('rejects upgrade without credentials', async () => {
    await expectRejected(v3Url());
  });

  it('serves global session messages, response and recovery over the real stack without a handshake frame', async () => {
    const { ws, frames } = await openV3();
    sockets.push(ws);

    const created = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await created.json()) as { data: { id: string } };
    const sessionId = body.data.id;

    await vi.waitFor(
      () => {
        const sessionFrames = frames.filter((frame) => frame['type'] === 'session');
        expect(sessionFrames).toHaveLength(1);
        expect(sessionFrames[0]).toMatchObject({
          subtype: 'created',
          session: { id: sessionId },
        });
      },
      { timeout: 5000 },
    );

    ws.send(JSON.stringify({ type: 'subscribe', request_id: 'r1', session_id: sessionId }));
    await vi.waitFor(
      () => {
        const responseIndex = frames.findIndex(
          (frame) => frame['type'] === 'response' && frame['request_id'] === 'r1',
        );
        expect(responseIndex).toBeGreaterThanOrEqual(0);
        expect(frames[responseIndex]).toMatchObject({ code: ErrorCode.SUCCESS });
        const stateIndex = frames.findIndex((frame) => frame['type'] === 'session.state');
        expect(stateIndex).toBeGreaterThan(responseIndex);
        expect(frames[stateIndex]).toMatchObject({ session_id: sessionId, status: 'idle' });
      },
      { timeout: 5000 },
    );
  });
});
