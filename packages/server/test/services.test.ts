

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationService, ServiceCollection, EventService, FsWatcherService, IApprovalService, IEventService, ILogService, IQuestionService, type ApprovalResponse, type QuestionResult, type FsWatcherServiceOptions, type IEnvironmentService, type ILogService as ILoggerT, type ISessionService } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';

import { ApprovalService } from '#/services/approval/approvalService';
import { QuestionService } from '#/services/question/questionService';
import {
  ISessionClientsService,
  type ISessionClientsService as ISessionClientsServiceT,
} from '#/services/gateway';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';
import type { WsConnection } from '../src/ws/connection';

class TestLogger implements ILoggerT {
  readonly _serviceBrand: undefined;

  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
  child(): ILoggerT {
    return this;
  }
}

class FakeSessionClients implements ISessionClientsServiceT {
  readonly _serviceBrand: undefined;

  private readonly _bySession = new Map<string, Set<WsConnection>>();
  subscribe(c: WsConnection, sid: string): void {
    let set = this._bySession.get(sid);
    if (!set) {
      set = new Set();
      this._bySession.set(sid, set);
    }
    set.add(c);
  }
  unsubscribe(c: WsConnection, sid: string): void {
    this._bySession.get(sid)?.delete(c);
  }
  getConnections(sid: string): Iterable<WsConnection> {
    return this._bySession.get(sid)?.values() ?? [];
  }
  forgetConnection(c: WsConnection): void {
    for (const set of this._bySession.values()) set.delete(c);
  }
  subscriberCount(sid: string): number {
    return this._bySession.get(sid)?.size ?? 0;
  }
}

class FakeConnectionRegistry {
  readonly _serviceBrand: undefined;
  private readonly conns = new Map<string, WsConnection>();

  constructor(connections: WsConnection[] = []) {
    for (const conn of connections) this.conns.set(conn.id, conn);
  }

  add(conn: WsConnection): void {
    this.conns.set(conn.id, conn);
  }
  remove(connId: string): void {
    this.conns.delete(connId);
  }
  get(connId: string): WsConnection | undefined {
    return this.conns.get(connId);
  }
  values(): Iterable<WsConnection> {
    return this.conns.values();
  }
  closeAll(): void {
    this.conns.clear();
  }
  size(): number {
    return this.conns.size;
  }
}

function fakeConn(id = 'conn_x'): { id: string; sent: unknown[]; send(m: unknown): void } & WsConnection {
  const sent: unknown[] = [];
  return {
    id,
    sent,
    send(m: unknown): void {
      sent.push(m);
    },
  } as unknown as { id: string; sent: unknown[]; send(m: unknown): void } & WsConnection;
}

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

class FakeWatcher {
  readonly added: string[][] = [];
  readonly unwatched: string[][] = [];
  readonly unwatchErrors = new Map<string, Error>();
  closeCalls = 0;

  add(paths: string | string[]): this {
    this.added.push(Array.isArray(paths) ? paths : [paths]);
    return this;
  }

  unwatch(paths: string | string[]): this {
    const items = Array.isArray(paths) ? paths : [paths];
    this.unwatched.push(items);
    const error = items.map((path) => this.unwatchErrors.get(path)).find(Boolean);
    if (error) throw error;
    return this;
  }

  on(): this {
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

type TestFsWatcher = ReturnType<NonNullable<FsWatcherServiceOptions['watcherFactory']>>;

let ix: InstantiationService;
let testLogger: TestLogger;

const tmpHomeDirs: string[] = [];

/** Throwaway `IEnvironmentService` whose homeDir is a fresh temp dir. */
function tmpEnv(): IEnvironmentService {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-server-test-'));
  tmpHomeDirs.push(dir);
  return { _serviceBrand: undefined, homeDir: dir, configPath: join(dir, 'config.toml') };
}

beforeEach(() => {
  testLogger = new TestLogger();
  const collection = new ServiceCollection([ILogService, testLogger]);
  ix = new InstantiationService(collection);
});

afterEach(() => {
  ix.dispose();
  for (const dir of tmpHomeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WSBroadcastService (WS transport pump)', () => {
  let homeDir: string;

  const makeEnv = (): IEnvironmentService => ({
    _serviceBrand: undefined,
    homeDir,
    configPath: `${homeDir}/config.toml`,
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-ws-broadcast-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('publishes event with seq=1, broadcasts to subscribers, advances seq monotonically per session', async () => {
    const clients = new FakeSessionClients();
    const c1 = fakeConn('conn_a');
    const c2 = fakeConn('conn_b');
    clients.subscribe(c1, 'sid_test');
    clients.subscribe(c2, 'sid_test');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    bus.publish({ type: 'fake.x', sessionId: 'sid_test', agentId: 'main' } as unknown as Event);
    bus.publish({ type: 'fake.y', sessionId: 'sid_test', agentId: 'main' } as unknown as Event);
    await broadcast._drainForTest('sid_test');

    expect(c1.sent.length).toBe(2);
    expect(c2.sent.length).toBe(2);
    const env1 = c1.sent[0] as { seq: number; session_id: string; type: string; epoch?: string };
    const env2 = c1.sent[1] as { seq: number; session_id: string; type: string };
    expect(env1.seq).toBe(1);
    expect(env1.session_id).toBe('sid_test');
    expect(env1.type).toBe('fake.x');
    expect(env1.epoch).toMatch(/^ep_/);
    expect(env2.seq).toBe(2);
    expect(env2.type).toBe('fake.y');
    broadcast.dispose();
    bus.dispose();
  });

  it('per-session seq counters are independent', async () => {
    const clients = new FakeSessionClients();
    const cA = fakeConn('conn_a');
    const cB = fakeConn('conn_b');
    clients.subscribe(cA, 'sid_a');
    clients.subscribe(cB, 'sid_b');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    bus.publish({ type: 'e1', sessionId: 'sid_a', agentId: 'main' } as unknown as Event);
    bus.publish({ type: 'e1', sessionId: 'sid_b', agentId: 'main' } as unknown as Event);
    bus.publish({ type: 'e2', sessionId: 'sid_a', agentId: 'main' } as unknown as Event);
    await broadcast._drainForTest('sid_a');
    await broadcast._drainForTest('sid_b');

    const aSeqs = cA.sent.map((m) => (m as { seq: number }).seq);
    const bSeqs = cB.sent.map((m) => (m as { seq: number }).seq);
    expect(aSeqs).toEqual([1, 2]);
    expect(bSeqs).toEqual([1]);
    expect(broadcast._currentSeqForTest('sid_a')).toBe(2);
    expect(broadcast._currentSeqForTest('sid_b')).toBe(1);
    broadcast.dispose();
    bus.dispose();
  });

  it('does not broadcast to connections subscribed to a different session', async () => {
    const clients = new FakeSessionClients();
    const onA = fakeConn('conn_a');
    const onOther = fakeConn('conn_other');
    clients.subscribe(onA, 'sid_a');
    clients.subscribe(onOther, 'sid_other');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    bus.publish({ type: 'evt', sessionId: 'sid_a', agentId: 'main' } as unknown as Event);
    await broadcast._drainForTest('sid_a');
    expect(onA.sent.length).toBe(1);
    expect(onOther.sent.length).toBe(0);
    broadcast.dispose();
    bus.dispose();
  });

  it('broadcasts session.created to every live connection', async () => {
    const clients = new FakeSessionClients();
    const subscribed = fakeConn('conn_subscribed');
    const listOnly = fakeConn('conn_list_only');
    clients.subscribe(subscribed, 'sid_new');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(
      bus,
      testLogger,
      clients,
      new FakeConnectionRegistry([subscribed, listOnly]),
      makeEnv(),
    );

    bus.publish({
      type: 'event.session.created',
      sessionId: 'sid_new',
      agentId: 'main',
      session: { id: 'sid_new' },
    } as unknown as Event);
    await broadcast._drainForTest('sid_new');

    expect(subscribed.sent).toHaveLength(1);
    expect(listOnly.sent).toHaveLength(1);
    expect((listOnly.sent[0] as { type: string }).type).toBe('event.session.created');
    broadcast.dispose();
    bus.dispose();
  });

  it('drops events without a sessionId / session_id and warns', () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_x');
    const warnSpy = vi.spyOn(testLogger, 'warn');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    bus.publish({ type: 'no_sid' } as unknown as Event);

    expect(c.sent.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    broadcast.dispose();
    bus.dispose();
  });

  it('post-dispose, publish reaches no subscribers (broadcast unsubscribed)', async () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_x');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    broadcast.dispose();
    bus.publish({ type: 'late', sessionId: 'sid_x', agentId: 'main' } as unknown as Event);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.sent.length).toBe(0);
    bus.dispose();
  });

  it('getBufferedSince returns events with seq > cursor.seq when the gap is serveable', async () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_test');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: `e${i}`, sessionId: 'sid_test', agentId: 'main' } as unknown as Event);
    }
    const replay = await broadcast.getBufferedSince('sid_test', { seq: 2 });
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(replay.currentSeq).toBe(5);
    expect(replay.epoch).toMatch(/^ep_/);
    await broadcast._drainForTest('sid_test');
    broadcast.dispose();
    bus.dispose();
  });

  it('getBufferedSince forces a resync for a cursor ahead of the journal (stale v1 cursor)', async () => {
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, new FakeSessionClients(), new FakeConnectionRegistry(), makeEnv());
    const replay = await broadcast.getBufferedSince('sid_new', { seq: 5 });
    expect(replay.events).toEqual([]);
    expect(replay.resyncRequired).toBe('epoch_changed');
    expect(replay.currentSeq).toBe(0);
    broadcast.dispose();
    bus.dispose();
  });

  it('getBufferedSince forces a resync on epoch mismatch', async () => {
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, new FakeSessionClients(), new FakeConnectionRegistry(), makeEnv());
    bus.publish({ type: 'e', sessionId: 'sid_e', agentId: 'main' } as unknown as Event);
    await broadcast._drainForTest('sid_e');
    const replay = await broadcast.getBufferedSince('sid_e', { seq: 0, epoch: 'ep_other' });
    expect(replay.resyncRequired).toBe('epoch_changed');
    broadcast.dispose();
    bus.dispose();
  });

  it('seq and epoch survive a server restart (journal recovery) and serve replay from disk', async () => {
    const bus1 = new EventService();
    const b1 = new WSBroadcastService(bus1, testLogger, new FakeSessionClients(), new FakeConnectionRegistry(), makeEnv());
    for (let i = 0; i < 3; i++) {
      bus1.publish({ type: `e${i}`, sessionId: 'sid_p', agentId: 'main' } as unknown as Event);
    }
    const before = await b1.getCursor('sid_p');
    expect(before.seq).toBe(3);
    b1.dispose();
    bus1.dispose();
    // Let the write-behind flush settle.
    await new Promise((r) => setTimeout(r, 50));

    const bus2 = new EventService();
    const b2 = new WSBroadcastService(bus2, testLogger, new FakeSessionClients(), new FakeConnectionRegistry(), makeEnv());
    const after = await b2.getCursor('sid_p');
    expect(after.seq).toBe(3);
    expect(after.epoch).toBe(before.epoch);

    // Replay across the restart comes from the on-disk journal.
    const replay = await b2.getBufferedSince('sid_p', { seq: 1, epoch: before.epoch });
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events.map((e) => e.seq)).toEqual([2, 3]);

    // New events continue the persisted seq.
    bus2.publish({ type: 'e3', sessionId: 'sid_p', agentId: 'main' } as unknown as Event);
    await b2._drainForTest('sid_p');
    expect(b2._currentSeqForTest('sid_p')).toBe(4);
    b2.dispose();
    bus2.dispose();
  });

  it('volatile events ride the watermark, are flagged, and are not journaled or replayed', async () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_v');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), makeEnv());

    bus.publish({
      type: 'turn.started',
      sessionId: 'sid_v',
      agentId: 'main',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event);
    bus.publish({
      type: 'assistant.delta',
      sessionId: 'sid_v',
      agentId: 'main',
      turnId: 1,
      delta: 'hel',
    } as unknown as Event);
    bus.publish({
      type: 'assistant.delta',
      sessionId: 'sid_v',
      agentId: 'main',
      turnId: 1,
      delta: 'lo',
    } as unknown as Event);
    await broadcast._drainForTest('sid_v');

    expect(c.sent.length).toBe(3);
    const turnStarted = c.sent[0] as { seq: number; volatile?: boolean };
    const delta1 = c.sent[1] as { seq: number; volatile?: boolean; offset?: number };
    const delta2 = c.sent[2] as { seq: number; volatile?: boolean; offset?: number };
    expect(turnStarted.seq).toBe(1);
    expect(turnStarted.volatile).toBeUndefined();
    expect(delta1.volatile).toBe(true);
    expect(delta1.seq).toBe(1); // watermark, not advanced
    expect(delta1.offset).toBe(0);
    expect(delta2.offset).toBe(3);

    // Replay from 0 returns only the durable event.
    const replay = await broadcast.getBufferedSince('sid_v', { seq: 0 });
    expect(replay.events.map((e) => e.seq)).toEqual([1]);
    expect(replay.currentSeq).toBe(1);

    // The in-flight turn snapshot has the accumulated text.
    const snap = await broadcast.getSnapshotState('sid_v');
    expect(snap.seq).toBe(1);
    expect(snap.inFlightTurn?.assistant_text).toBe('hello');
    broadcast.dispose();
    bus.dispose();
  });

  it('getSnapshotState clears the in-flight turn after turn.ended', async () => {
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, new FakeSessionClients(), new FakeConnectionRegistry(), makeEnv());
    bus.publish({
      type: 'turn.started',
      sessionId: 'sid_t',
      agentId: 'main',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event);
    bus.publish({
      type: 'turn.ended',
      sessionId: 'sid_t',
      agentId: 'main',
      turnId: 1,
      reason: 'completed',
    } as unknown as Event);
    const snap = await broadcast.getSnapshotState('sid_t');
    expect(snap.inFlightTurn).toBeNull();
    expect(snap.seq).toBe(2);
    broadcast.dispose();
    bus.dispose();
  });
});

describe('FsWatcherService', () => {
  it('shares watched paths and releases the underlying watcher on the last reference', () => {
    const watcher = new FakeWatcher();
    const service = new FsWatcherService(
      { resolve: () => undefined },
      { watcherFactory: () => watcher as unknown as TestFsWatcher },
      testLogger,
      {} as ISessionService,
    );
    const path = '/workspace/src';

    service.addPaths('sid', 'conn-a', [path]);
    service.addPaths('sid', 'conn-b', [path]);

    expect(watcher.added).toEqual([[path]]);
    expect(service.watchedPaths('conn-a', 'sid')).toEqual([path]);
    expect(service.watchedPaths('conn-b', 'sid')).toEqual([path]);

    service.removePaths('sid', 'conn-a', [path]);

    expect(watcher.unwatched).toEqual([]);
    expect(watcher.closeCalls).toBe(0);
    expect(service.watchedPaths('conn-a', 'sid')).toEqual([]);
    expect(service.watchedPaths('conn-b', 'sid')).toEqual([path]);

    service.removePaths('sid', 'conn-b', [path]);

    expect(watcher.unwatched).toEqual([[path]]);
    expect(watcher.closeCalls).toBe(1);
    expect(service.countForConnection('conn-a')).toBe(0);
    expect(service.countForConnection('conn-b')).toBe(0);
    service.dispose();
  });

  it('releases all removed path references before throwing aggregate unwatch errors', () => {
    const watcher = new FakeWatcher();
    const service = new FsWatcherService(
      { resolve: () => undefined },
      { watcherFactory: () => watcher as unknown as TestFsWatcher },
      testLogger,
      {} as ISessionService,
    );
    const paths = ['/workspace/src', '/workspace/docs', '/workspace/notes'];
    watcher.unwatchErrors.set(paths[0]!, new Error('unwatch-src'));
    watcher.unwatchErrors.set(paths[1]!, new Error('unwatch-docs'));

    service.addPaths('sid', 'conn', paths);
    const error = captureThrown(() => {
      service.removePaths('sid', 'conn', paths.slice(0, 2));
    });

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((err) => (err as Error).message)).toEqual([
      'unwatch-src',
      'unwatch-docs',
    ]);
    expect(watcher.unwatched).toEqual([[paths[0]!], [paths[1]!]]);
    expect(service.watchedPaths('conn', 'sid')).toEqual([paths[2]!]);
    expect(watcher.closeCalls).toBe(0);
    service.dispose();
  });
});

describe('ApprovalService (broadcasts + resolve-by-approval_id)', () => {
  function makeBrokerWithBus(): {
    broker: ApprovalService;
    bus: EventService;
    broadcast: WSBroadcastService;
    clients: FakeSessionClients;
    conn: ReturnType<typeof fakeConn>;
  } {
    const clients = new FakeSessionClients();
    const conn = fakeConn('conn_subscriber');
    clients.subscribe(conn, 'sess_1');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), tmpEnv());
    const broker = new ApprovalService(testLogger, bus);
    return { broker, bus, broadcast, clients, conn };
  }

  function extractApprovalId(sentFrames: unknown[]): string | undefined {
    for (const frame of sentFrames) {
      const env = frame as { type: string; payload: { approval_id?: string } };
      if (env.type === 'event.approval.requested' && env.payload.approval_id) {
        return env.payload.approval_id;
      }
    }
    return undefined;
  }

  it('broadcasts event.approval.requested AND settles via resolve(approval_id, response)', async () => {
    const { broker, bus, broadcast, conn } = makeBrokerWithBus();
    const pending = broker.request({
      sessionId: 'sess_1',
      agentId: 'agent_1',
      toolCallId: 'tc_approval_1',
      toolName: 'shell.run',
      action: 'Run',
      display: { kind: 'generic', summary: 'test' },
    } as Parameters<typeof broker.request>[0]);
    await broadcast._drainForTest('sess_1');

    const approvalId = extractApprovalId(conn.sent);
    expect(approvalId).toBeDefined();
    expect(broker.isPending(approvalId!)).toBe(true);

    const response: ApprovalResponse = { decision: 'approved' };
    broker.resolve(approvalId!, response);
    await expect(pending).resolves.toEqual(response);
    await broadcast._drainForTest('sess_1');

    const resolvedFrame = conn.sent.find(
      (f) => (f as { type: string }).type === 'event.approval.resolved',
    );
    expect(resolvedFrame).toBeDefined();
    expect(broker.isPending(approvalId!)).toBe(false);
    expect(broker.isRecentlyResolved(approvalId!)).toBe(true);

    broker.dispose();
    broadcast.dispose();
    bus.dispose();
  });

  it('dispose rejects all pending requests with "server shutting down"', async () => {
    const { broker, bus, broadcast } = makeBrokerWithBus();
    const p1 = broker.request({
      sessionId: 'sess_1',
      agentId: 'a',
      toolCallId: 'tc_a',
      toolName: 't',
      action: 'a',
      display: { kind: 'generic', summary: 'g' },
    } as Parameters<typeof broker.request>[0]);
    const p2 = broker.request({
      sessionId: 'sess_1',
      agentId: 'a',
      toolCallId: 'tc_b',
      toolName: 't',
      action: 'a',
      display: { kind: 'generic', summary: 'g' },
    } as Parameters<typeof broker.request>[0]);

    broker.dispose();
    await expect(p1).rejects.toThrow(/server shutting down/);
    await expect(p2).rejects.toThrow(/server shutting down/);
    broadcast.dispose();
    bus.dispose();
  });

  it('resolve() for an unknown id is a no-op (REST route handles 40404 via isPending)', () => {
    const { broker, bus, broadcast } = makeBrokerWithBus();
    broker.resolve('does-not-exist', { decision: 'approved' });
    expect(broker.isPending('does-not-exist')).toBe(false);
    broker.dispose();
    broadcast.dispose();
    bus.dispose();
  });
});

describe('QuestionService (broadcasts + dismiss)', () => {
  function makeQuestionBroker(): {
    broker: QuestionService;
    bus: EventService;
    broadcast: WSBroadcastService;
    clients: FakeSessionClients;
    conn: ReturnType<typeof fakeConn>;
  } {
    const clients = new FakeSessionClients();
    const conn = fakeConn('conn_q_subscriber');
    clients.subscribe(conn, 's');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients, new FakeConnectionRegistry(), tmpEnv());
    const broker = new QuestionService(testLogger, bus);
    return { broker, bus, broadcast, clients, conn };
  }

  function extractQuestionId(sentFrames: unknown[]): string | undefined {
    for (const frame of sentFrames) {
      const env = frame as { type: string; payload: { question_id?: string } };
      if (env.type === 'event.question.requested' && env.payload.question_id) {
        return env.payload.question_id;
      }
    }
    return undefined;
  }

  it('broadcasts event.question.requested AND settles via resolve(question_id, answers)', async () => {
    const { broker, bus, broadcast, conn } = makeQuestionBroker();
    const pending = broker.request({
      sessionId: 's',
      agentId: 'a',
      toolCallId: 'tc_q1',
      questions: [
        {
          question: '?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    } as Parameters<typeof broker.request>[0]);
    await broadcast._drainForTest('s');

    const questionId = extractQuestionId(conn.sent);
    expect(questionId).toBeDefined();
    expect(broker.isPending(questionId!)).toBe(true);

    const response: QuestionResult = { answers: { q_0: 'opt_0_0' } };
    broker.resolve(questionId!, response);
    await expect(pending).resolves.toEqual(response);
    await broadcast._drainForTest('s');

    const answeredFrame = conn.sent.find(
      (f) => (f as { type: string }).type === 'event.question.answered',
    );
    expect(answeredFrame).toBeDefined();

    broker.dispose();
    broadcast.dispose();
    bus.dispose();
  });

  it('dismiss(question_id) broadcasts event.question.dismissed AND resolves Promise with null (SCHEMAS §6.3)', async () => {
    const { broker, bus, broadcast, conn } = makeQuestionBroker();
    const pending = broker.request({
      sessionId: 's',
      agentId: 'a',
      questions: [
        {
          question: '?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    } as Parameters<typeof broker.request>[0]);
    await broadcast._drainForTest('s');

    const questionId = extractQuestionId(conn.sent);
    expect(questionId).toBeDefined();

    broker.dismiss(questionId!);
    await expect(pending).resolves.toBeNull();
    await broadcast._drainForTest('s');

    const dismissedFrame = conn.sent.find(
      (f) => (f as { type: string }).type === 'event.question.dismissed',
    );
    expect(dismissedFrame).toBeDefined();
    expect(broker.isPending(questionId!)).toBe(false);
    expect(broker.isRecentlyResolved(questionId!)).toBe(true);

    broker.dispose();
    broadcast.dispose();
    bus.dispose();
  });

  it('dispose rejects pending question Promises', async () => {
    const { broker, bus, broadcast } = makeQuestionBroker();
    const pending = broker.request({
      sessionId: 's',
      agentId: 'a',
      questions: [
        { question: '?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    } as Parameters<typeof broker.request>[0]);

    broker.dispose();
    await expect(pending).rejects.toThrow(/server shutting down/);
    broadcast.dispose();
    bus.dispose();
  });
});

describe('DI graph — broker resolution through the container', () => {
  it('resolves broker decorators against the same instances registered in the collection', () => {
    const clients = new FakeSessionClients();
    const eventBus = new EventService();
    const approval = new ApprovalService(testLogger, eventBus);
    const question = new QuestionService(testLogger, eventBus);

    const collection = new ServiceCollection(
      [ILogService, testLogger],
      [ISessionClientsService, clients],
      [IEventService, eventBus],
      [IApprovalService, approval],
      [IQuestionService, question],
    );
    const localIx = new InstantiationService(collection);
    localIx.invokeFunction((a) => {
      expect(a.get(ISessionClientsService)).toBe(clients);
      expect(a.get(IEventService)).toBe(eventBus);
      expect(a.get(IApprovalService)).toBe(approval);
      expect(a.get(IQuestionService)).toBe(question);
      expect(a.get(ILogService)).toBe(testLogger);
    });
    localIx.dispose();
  });
});
