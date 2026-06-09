/**
 * Peer service + event/broadcast service unit tests.
 *
 * Hermetic: we wire a real `InstantiationService` with stub `ILogService` impl,
 * exercise `request` / `resolve` / `dismiss` / `dispose` directly, and use a
 * stub `ISessionClientsService` (no real sockets) so the daemon-side
 * `WSBroadcastService` can fan out to recorded fake connections.
 *
 * Timing: we override `timeoutMs` to a small value (50ms) so a real timer
 * fires within the test rather than waiting 60s. `vi.useFakeTimers` would
 * also work but is heavier and forces every consumer's Promise into manual
 * flushing.
 *
 * **Phase split**: `IEventService` (services pkg) is now a pure in-process
 * pub-sub bus — no sessionId extraction, no per-session seq, no ring buffer,
 * no WS fan-out. Those daemon transport concerns live on
 * `WSBroadcastService` (daemon pkg), which subscribes to
 * `IEventService.onDidPublish` in its constructor. Tests in this file
 * construct both: `bus = new EventService()`, then
 * `broadcast = new WSBroadcastService(bus, ...)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
  type ApprovalResponse,
  type QuestionResult,
} from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';
import {
  EventService,
  IApprovalService,
  IEventService,
  IQuestionService,
} from '@moonshot-ai/services';

import { ApprovalService } from '#/services/approval/approvalService';
import { ILogService, type ILogService as ILoggerT } from '#/services/logger';
import { QuestionService } from '#/services/question/questionService';
import {
  ISessionClientsService,
  type ISessionClientsService as ISessionClientsServiceT,
} from '#/services/gateway';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';
import type { WsConnection } from '../src/ws/connection';

/** No-op logger that satisfies `ILogService` without pulling pino. */
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

/**
 * In-memory subscriber index. Same shape as `SessionClientsService` but with
 * Set-based bookkeeping inlined so the test doesn't depend on the real impl.
 */
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

/** Side-effect-recording `WsConnection`-shaped fake — only `.send` is used by the bus. */
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

let ix: InstantiationService;
let testLogger: TestLogger;

beforeEach(() => {
  testLogger = new TestLogger();
  const collection = new ServiceCollection([ILogService, testLogger]);
  ix = new InstantiationService(collection);
});

afterEach(() => {
  ix.dispose();
});

describe('WSBroadcastService (WS transport pump)', () => {
  it('publishes event with seq=1, broadcasts to subscribers, advances seq monotonically per session', () => {
    const clients = new FakeSessionClients();
    const c1 = fakeConn('conn_a');
    const c2 = fakeConn('conn_b');
    clients.subscribe(c1, 'sid_test');
    clients.subscribe(c2, 'sid_test');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    bus.publish({ type: 'fake.x', sessionId: 'sid_test' } as unknown as Event);
    bus.publish({ type: 'fake.y', sessionId: 'sid_test' } as unknown as Event);

    expect(c1.sent.length).toBe(2);
    expect(c2.sent.length).toBe(2);
    const env1 = c1.sent[0] as { seq: number; session_id: string; type: string };
    const env2 = c1.sent[1] as { seq: number; session_id: string; type: string };
    expect(env1.seq).toBe(1);
    expect(env1.session_id).toBe('sid_test');
    expect(env1.type).toBe('fake.x');
    expect(env2.seq).toBe(2);
    expect(env2.type).toBe('fake.y');
    broadcast.dispose();
    bus.dispose();
  });

  it('per-session seq counters are independent', () => {
    const clients = new FakeSessionClients();
    const cA = fakeConn('conn_a');
    const cB = fakeConn('conn_b');
    clients.subscribe(cA, 'sid_a');
    clients.subscribe(cB, 'sid_b');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    bus.publish({ type: 'e1', sessionId: 'sid_a' } as unknown as Event);
    bus.publish({ type: 'e1', sessionId: 'sid_b' } as unknown as Event);
    bus.publish({ type: 'e2', sessionId: 'sid_a' } as unknown as Event);

    const aSeqs = cA.sent.map((m) => (m as { seq: number }).seq);
    const bSeqs = cB.sent.map((m) => (m as { seq: number }).seq);
    expect(aSeqs).toEqual([1, 2]);
    expect(bSeqs).toEqual([1]);
    expect(broadcast._currentSeqForTest('sid_a')).toBe(2);
    expect(broadcast._currentSeqForTest('sid_b')).toBe(1);
    broadcast.dispose();
    bus.dispose();
  });

  it('does not broadcast to connections subscribed to a different session', () => {
    const clients = new FakeSessionClients();
    const onA = fakeConn('conn_a');
    const onOther = fakeConn('conn_other');
    clients.subscribe(onA, 'sid_a');
    clients.subscribe(onOther, 'sid_other');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    bus.publish({ type: 'evt', sessionId: 'sid_a' } as unknown as Event);
    expect(onA.sent.length).toBe(1);
    expect(onOther.sent.length).toBe(0);
    broadcast.dispose();
    bus.dispose();
  });

  it('drops events without a sessionId / session_id and warns', () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_x');
    const warnSpy = vi.spyOn(testLogger, 'warn');

    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    bus.publish({ type: 'no_sid' } as unknown as Event);

    expect(c.sent.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    broadcast.dispose();
    bus.dispose();
  });

  it('post-dispose, publish reaches no subscribers (broadcast unsubscribed)', () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_x');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    broadcast.dispose();
    bus.publish({ type: 'late', sessionId: 'sid_x' } as unknown as Event);
    expect(c.sent.length).toBe(0);
    bus.dispose();
  });

  it('getBufferedSince returns events with seq > lastSeq when buffer covers the gap', () => {
    const clients = new FakeSessionClients();
    const c = fakeConn();
    clients.subscribe(c, 'sid_test');
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: `e${i}`, sessionId: 'sid_test' } as unknown as Event);
    }
    const replay = broadcast.getBufferedSince('sid_test', 2);
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(replay.currentSeq).toBe(5);
    broadcast.dispose();
    bus.dispose();
  });

  it('getBufferedSince returns empty + currentSeq=0 for a never-seen session', () => {
    const bus = new EventService();
    const broadcast = new WSBroadcastService(bus, testLogger, new FakeSessionClients());
    const replay = broadcast.getBufferedSince('sid_new', 5);
    expect(replay.events).toEqual([]);
    expect(replay.resyncRequired).toBe(false);
    expect(replay.currentSeq).toBe(0);
    broadcast.dispose();
    bus.dispose();
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
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
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

    // Subscriber sees the broadcast — extract the daemon-minted approval_id.
    const approvalId = extractApprovalId(conn.sent);
    expect(approvalId).toBeDefined();
    expect(broker.isPending(approvalId!)).toBe(true);

    const response: ApprovalResponse = { decision: 'approved' };
    broker.resolve(approvalId!, response);
    await expect(pending).resolves.toEqual(response);

    // Resolved broadcast must follow.
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

  it('rejects with ApprovalExpiredError + broadcasts event.approval.expired after timeoutMs', async () => {
    const { broker, bus, broadcast, conn } = makeBrokerWithBus();
    broker._setTimeoutMsForTests(30);
    const pending = broker.request({
      sessionId: 'sess_1',
      agentId: 'agent_1',
      toolCallId: 'tc_timeout',
      toolName: 'shell.run',
      action: 'Run',
      display: { kind: 'generic', summary: 'test' },
    } as Parameters<typeof broker.request>[0]);

    await expect(pending).rejects.toMatchObject({
      name: 'ApprovalExpiredError',
    });
    const expiredFrame = conn.sent.find(
      (f) => (f as { type: string }).type === 'event.approval.expired',
    );
    expect(expiredFrame).toBeDefined();
    broker.dispose();
    broadcast.dispose();
    bus.dispose();
  });

  it('dispose rejects all pending requests with "daemon shutting down"', async () => {
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
    await expect(p1).rejects.toThrow(/daemon shutting down/);
    await expect(p2).rejects.toThrow(/daemon shutting down/);
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
    const broadcast = new WSBroadcastService(bus, testLogger, clients);
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

    const questionId = extractQuestionId(conn.sent);
    expect(questionId).toBeDefined();
    expect(broker.isPending(questionId!)).toBe(true);

    const response: QuestionResult = { answers: { q_0: 'opt_0_0' } };
    broker.resolve(questionId!, response);
    await expect(pending).resolves.toEqual(response);

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

    const questionId = extractQuestionId(conn.sent);
    expect(questionId).toBeDefined();

    broker.dismiss(questionId!);
    await expect(pending).resolves.toBeNull();

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

  it('60s timeout broadcasts event.question.expired + rejects QuestionExpiredError', async () => {
    const { broker, bus, broadcast, conn } = makeQuestionBroker();
    broker._setTimeoutMsForTests(30);
    const pending = broker.request({
      sessionId: 's',
      agentId: 'a',
      questions: [
        { question: '?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    } as Parameters<typeof broker.request>[0]);

    await expect(pending).rejects.toMatchObject({ name: 'QuestionExpiredError' });
    const expiredFrame = conn.sent.find(
      (f) => (f as { type: string }).type === 'event.question.expired',
    );
    expect(expiredFrame).toBeDefined();

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
    await expect(pending).rejects.toThrow(/daemon shutting down/);
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

    // We don't need a CoreProcessService for this — just check the wiring symmetry.
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
