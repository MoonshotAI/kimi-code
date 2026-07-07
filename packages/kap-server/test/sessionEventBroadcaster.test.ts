/**
 * `SessionEventBroadcaster` — seq stamping, volatile vs durable, fan-out, replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IScopeHandle, Scope, WireEmission } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IAgentWireService,
  IEventService,
  ISessionInteractionService,
  ISessionLifecycleService,
  SessionInteractionService,
} from '@moonshot-ai/agent-core-v2';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSink {
  private handlers: Array<(e: WireEmission) => void> = [];
  onEmission(handler: (e: WireEmission) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: AgentEvent): void {
    const emission = { type: 'signal', signal: e } as unknown as WireEmission;
    for (const h of [...this.handlers]) h(emission);
  }
}

class FakeEventBus {
  private handlers: Array<(e: { type: string; payload: unknown }) => void> = [];
  subscribe(handler: (e: { type: string; payload: unknown }) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: { type: string; payload: unknown }): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly sink = new FakeSink();
  readonly accessor;
  constructor(readonly id: string) {
    this.accessor = {
      get: (t: unknown) => (t === IAgentWireService ? this.sink : undefined),
    };
  }
  dispose(): void {}
}

class FakeLifecycle {
  readonly handles: FakeAgentHandle[] = [];
  /** Real interaction kernel — served at the session accessor. */
  readonly interactions = new SessionInteractionService();
  private createHandlers: Array<(h: IScopeHandle) => void> = [];
  private disposeHandlers: Array<(id: string) => void> = [];
  list(): readonly FakeAgentHandle[] {
    return this.handles;
  }
  getHandle(id: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === id);
  }
  onDidCreate(h: (h: IScopeHandle) => void) {
    this.createHandlers.push(h);
    return { dispose: () => {} };
  }
  onDidDispose(h: (id: string) => void) {
    this.disposeHandlers.push(h);
    return { dispose: () => {} };
  }
  addAgent(id: string): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    this.handles.push(handle);
    for (const cb of this.createHandlers) cb(handle as unknown as IScopeHandle);
    return handle;
  }
  removeAgent(id: string): void {
    const idx = this.handles.findIndex((h) => h.id === id);
    if (idx >= 0) this.handles.splice(idx, 1);
    for (const cb of this.disposeHandlers) cb(id);
  }
}

function makeCore(sessions: Map<string, FakeLifecycle>, eventBus = new FakeEventBus()): Scope {
  const accessor = {
    get(token: unknown): unknown {
      if (token === IEventService) return eventBus;
      if (token === ISessionLifecycleService) {
        return {
          get: (sid: string) => {
            const lifecycle = sessions.get(sid);
            if (lifecycle === undefined) return undefined;
            const sessionAccessor = {
              get: (t: unknown) => {
                if (t === IAgentLifecycleService) return lifecycle;
                if (t === ISessionInteractionService) return lifecycle.interactions;
                return undefined;
              },
            };
            return { id: sid, kind: 1, accessor: sessionAccessor, dispose: () => {} };
          },
        };
      }
      return undefined;
    },
  };
  return { accessor } as unknown as Scope;
}

function agentEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as unknown as AgentEvent;
}

function collectingTarget(): { target: BroadcastTarget; envelopes: EventEnvelope[] } {
  const envelopes: EventEnvelope[] = [];
  return { target: { send: (e) => envelopes.push(e) }, envelopes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventBroadcaster', () => {
  let dir: string;
  let sessions: Map<string, FakeLifecycle>;
  let eventBus: FakeEventBus;
  let bc: SessionEventBroadcaster;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    sessions = new Map();
    eventBus = new FakeEventBus();
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      core: makeCore(sessions, eventBus),
      maxBufferSize: 3,
    });
  });

  afterEach(async () => {
    await bc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('stamps monotonic seq on durable events and fans out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    expect(await bc.subscribe('s1', target)).toBe(true);

    main.sink.emit(agentEvent('turn.started', { turnId: 1 }));
    main.sink.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1'); // drain

    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
    expect(envelopes.every((e) => e.epoch === envelopes[0]!.epoch)).toBe(true);
    expect(envelopes[0]!.volatile).toBeUndefined();
  });

  it('fans out volatile events with the current watermark + offset, not journaled', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.sink.emit(agentEvent('turn.started', { turnId: 1 })); // durable seq 1
    main.sink.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' })); // volatile
    main.sink.emit(agentEvent('assistant.delta', { turnId: 1, delta: ' there' })); // volatile
    await bc.getCursor('s1');

    const vol = envelopes.filter((e) => e.volatile === true);
    expect(vol).toHaveLength(2);
    expect(vol.every((e) => e.seq === 1)).toBe(true); // rides the durable watermark
    expect(vol.map((e) => e.offset)).toEqual([0, 2]);
    expect((await bc.getCursor('s1')).seq).toBe(1); // seq did not advance
  });

  it('replays durable events since a cursor from the journal', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    main.sink.emit(agentEvent('turn.started', { turnId: 1 }));
    main.sink.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 1 });
    expect(result.resyncRequired).toBe(false);
    expect(result.events.map((e) => e.seq)).toEqual([2]);
    expect(result.currentSeq).toBe(2);
  });

  it('returns buffer_overflow when the gap exceeds the cap', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    for (let i = 0; i < 5; i++) main.sink.emit(agentEvent('turn.started', { turnId: i }));
    await bc.getCursor('s1'); // seq = 5, maxBufferSize = 3

    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe('buffer_overflow');
    expect(result.currentSeq).toBe(5);
  });

  it('returns epoch_changed for a mismatched epoch', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    const result = await bc.getBufferedSince('s1', { seq: 0, epoch: 'ep_wrong' });
    expect(result.resyncRequired).toBe('epoch_changed');
  });

  it('subscribes to agents created after activation (onDidCreate)', async () => {
    const lc = new FakeLifecycle();
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    const late = lc.addAgent('main'); // created after subscribe
    late.sink.emit(agentEvent('turn.started', { turnId: 7 }));
    await bc.getCursor('s1');

    expect(envelopes.map((e) => e.seq)).toEqual([1]);
  });

  it('getSnapshotState returns the in-flight turn', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.sink.emit(agentEvent('turn.started', { turnId: 1 }));
    main.sink.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hello' }));
    const snap = await bc.getSnapshotState('s1');

    expect(snap.seq).toBe(1); // only the durable turn.started advanced seq
    expect(snap.inFlightTurn).toMatchObject({ turn_id: 1, assistant_text: 'Hello' });
  });

  it('fans core model-catalog changes out to every session subscriber', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    eventBus.emit({
      type: 'event.model_catalog.changed',
      payload: {
        changed: [{ provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 }],
        unchanged: [],
        failed: [],
      },
    });

    await vi.waitFor(() => expect(envelopes).toHaveLength(1));
    expect(envelopes[0]).toMatchObject({
      type: 'event.model_catalog.changed',
      seq: 1,
      session_id: '__global__',
      payload: {
        type: 'event.model_catalog.changed',
        agentId: 'main',
        sessionId: '__global__',
      },
    });
  });

  it('subscribe returns false for an unknown session', async () => {
    const { target } = collectingTarget();
    expect(await bc.subscribe('nope', target)).toBe(false);
  });

  it('broadcasts session.meta.updated under the real session id and fans out to every connection', async () => {
    // Regression: a new session's first prompt auto-generates a title and the
    // daemon announces it via `session.meta.updated`. The event must be
    // addressed to the real session so clients can match it to a sidebar row;
    // stamping `session_id = '__global__'` left the row title stuck empty.
    // (No agents attached — `session.meta.updated` is a core event, not an
    // agent event, so the agent subscription path is irrelevant here.)
    sessions.set('s1', new FakeLifecycle());

    // A second, unrelated session with its own subscriber proves the meta
    // update still fans out globally (clients not subscribed to s1 learn the
    // new title too), even though the envelope is addressed to s1.
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    eventBus.emit({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试', isCustomTitle: false, lastPrompt: '测试' },
      },
    });

    await vi.waitFor(() => expect(s1View.envelopes).toHaveLength(1));
    await vi.waitFor(() => expect(s2View.envelopes).toHaveLength(1));

    expect(s1View.envelopes[0]).toMatchObject({
      type: 'session.meta.updated',
      session_id: 's1',
      payload: {
        type: 'session.meta.updated',
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试', lastPrompt: '测试' },
      },
    });
    expect(s1View.envelopes[0]!.session_id).not.toBe('__global__');
    // Fanned out to the non-subscriber under the same real session id.
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('broadcasts question requested / answered as durable v1 events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: {
        toolCallId: 'call_1',
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: 'event.question.requested',
      seq: 1,
      session_id: 's1',
      payload: {
        type: 'event.question.requested',
        agentId: 'main',
        sessionId: 's1',
        question_id: 'q1',
        session_id: 's1',
        tool_call_id: 'call_1',
        questions: [{ id: 'q_0', question: 'Pick one', options: [{ id: 'opt_0_0', label: 'A' }, { id: 'opt_0_1', label: 'B' }] }],
      },
    });
    expect(envelopes[0]!.volatile).toBeUndefined();

    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' }, method: 'enter' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toMatchObject({
      type: 'event.question.answered',
      seq: 2,
      session_id: 's1',
      payload: {
        question_id: 'q1',
        answers: { q_0: 'opt_0_0' },
      },
    });
    expect((envelopes[1]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
  });

  it('broadcasts question dismissed when resolved with null', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    });
    lc.interactions.respond('q1', null); // = ISessionQuestionService.dismiss
    await bc.getCursor('s1');

    expect(envelopes.map((e) => e.type)).toEqual([
      'event.question.requested',
      'event.question.dismissed',
    ]);
    expect(envelopes[1]!.payload).toMatchObject({ question_id: 'q1' });
    expect((envelopes[1]!.payload as { dismissed_at?: string }).dismissed_at).toBeTypeOf('string');
  });

  it('broadcasts approval requested / resolved as durable v1 events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'a1',
      kind: 'approval',
      payload: {
        toolCallId: 'call_9',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command', command: 'ls' },
      },
      origin: { turnId: 3 },
    });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: 'event.approval.requested',
      seq: 1,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        session_id: 's1',
        turn_id: 3,
        tool_call_id: 'call_9',
        tool_name: 'Bash',
        action: 'run',
        tool_input_display: { kind: 'command', command: 'ls' },
      },
    });

    lc.interactions.respond('a1', { decision: 'approved', scope: 'session' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toMatchObject({
      type: 'event.approval.resolved',
      seq: 2,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        decision: 'approved',
        scope: 'session',
      },
    });
    expect((envelopes[1]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
  });

  it('does not re-announce interactions already pending at activation, but still broadcasts their resolution', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    // Pending before the session is activated — the snapshot covers it.
    lc.interactions.enqueue({
      id: 'q0',
      kind: 'question',
      payload: { questions: [{ question: 'Early', options: [{ label: 'A' }] }] },
    });

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);
    await bc.getCursor('s1');
    expect(envelopes).toHaveLength(0);

    lc.interactions.respond('q0', { answers: { q_0: 'opt_0_0' } });
    await bc.getCursor('s1');
    expect(envelopes.map((e) => e.type)).toEqual(['event.question.answered']);
  });
});
