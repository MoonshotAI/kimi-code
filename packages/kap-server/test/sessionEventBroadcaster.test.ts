/**
 * `SessionEventBroadcaster` — seq stamping, volatile vs durable, fan-out, replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IScopeHandle, Scope } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  ISessionActivity,
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

class FakeAgentBus {
  private handlers: Array<(e: AgentEvent) => void> = [];
  subscribe(handler: (e: AgentEvent) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: AgentEvent): void {
    for (const h of [...this.handlers]) h(e);
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
  readonly bus = new FakeAgentBus();
  readonly accessor;
  constructor(readonly id: string) {
    this.accessor = {
      get: (t: unknown) => (t === IEventBus ? this.bus : undefined),
    };
  }
  dispose(): void {}
}

class FakeLifecycle {
  readonly handles: FakeAgentHandle[] = [];
  /** Real interaction kernel — served at the session accessor. */
  readonly interactions = new SessionInteractionService();
  baseStatus: 'idle' | 'running' = 'idle';
  readonly activity = {
    status: () => {
      if (this.interactions.listPending('approval').length > 0) return 'awaiting_approval';
      if (this.interactions.listPending('question').length > 0) return 'awaiting_question';
      return this.baseStatus;
    },
    isIdle: () => this.activity.status() === 'idle',
  };
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
                if (t === ISessionActivity) return lifecycle.activity;
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

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1'); // drain

    // `turn.started` emits a durable `event.session.status_changed(running)`
    // ahead of it and `turn.ended` emits a durable
    // `event.session.status_changed(idle)` after it, hence four durable events:
    // status_changed, turn.started, turn.ended, status_changed.
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(envelopes.every((e) => e.epoch === envelopes[0]!.epoch)).toBe(true);
    expect(envelopes[0]!.volatile).toBeUndefined();
  });

  it('fans out volatile events with the current watermark + offset, not journaled', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 })); // durable seq 1
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' })); // volatile
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: ' there' })); // volatile
    await bc.getCursor('s1');

    const vol = envelopes.filter((e) => e.volatile === true);
    expect(vol).toHaveLength(2);
    // `turn.started` is now seq 2 (a durable status_changed takes seq 1), so
    // the volatile deltas ride the watermark at 2.
    expect(vol.every((e) => e.seq === 2)).toBe(true); // rides the durable watermark
    expect(vol.map((e) => e.offset)).toEqual([0, 2]);
    expect((await bc.getCursor('s1')).seq).toBe(2); // seq did not advance
  });

  it('replays durable events since a cursor from the journal', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 1 });
    expect(result.resyncRequired).toBe(false);
    // seq 1 is the durable status_changed(running) (emitted ahead of
    // turn.started); events after it are turn.started (2), turn.ended (3) and
    // the durable status_changed(idle) (4) emitted on turn end.
    expect(result.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(result.currentSeq).toBe(4);
  });

  it('returns buffer_overflow when the gap exceeds the cap', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    for (let i = 0; i < 5; i++) main.bus.emit(agentEvent('turn.started', { turnId: i }));
    await bc.getCursor('s1'); // seq = 6 (one deduplicated running status + five turns), maxBufferSize = 3

    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe('buffer_overflow');
    expect(result.currentSeq).toBe(6);
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
    late.bus.emit(agentEvent('turn.started', { turnId: 7 }));
    await bc.getCursor('s1');

    // status_changed (seq 1) is emitted ahead of turn.started (seq 2).
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('getSnapshotState returns the in-flight turn', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hello' }));
    const snap = await bc.getSnapshotState('s1');

    expect(snap.seq).toBe(2); // durable status_changed + turn.started advanced seq; the delta is volatile
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

  it('broadcasts event.session.created under the real session id and fans out to every connection', async () => {
    // Regression: v2 publishes `event.session.created` on the core bus but the
    // broadcaster did not forward it, so clients that didn't issue the create
    // never learned the session exists. Without it, a later sessionStatusChanged
    // reducer is a no-op for the unknown session and kimi-web's Stop button
    // (gated on session.status === 'running') never renders.
    sessions.set('s1', new FakeLifecycle());
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    const session = { id: 's1', title: 't', status: 'idle' };
    eventBus.emit({
      type: 'event.session.created',
      payload: { agentId: 'main', sessionId: 's1', session },
    });

    await vi.waitFor(() => expect(s1View.envelopes).toHaveLength(1));
    await vi.waitFor(() => expect(s2View.envelopes).toHaveLength(1));

    expect(s1View.envelopes[0]).toMatchObject({
      type: 'event.session.created',
      session_id: 's1',
      payload: {
        type: 'event.session.created',
        agentId: 'main',
        sessionId: 's1',
        session,
      },
    });
    expect(s1View.envelopes[0]!.session_id).not.toBe('__global__');
    // Fanned out to the non-subscriber under the same real session id.
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('emits a durable event.session.status_changed(running) ahead of turn.started', async () => {
    // Regression: v2 derives the session status via ISessionActivity (a pure
    // pull) and publishes nothing, so the WS stream never carried the running
    // transition and kimi-web's Stop button never rendered. The broadcaster
    // now re-emits the authoritative running status on turn.started, ahead of
    // the turn event so the web projector's prompt_id binding applies after.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      type: 'event.session.status_changed',
      seq: 1,
      session_id: 's1',
      payload: {
        type: 'event.session.status_changed',
        status: 'running',
        previous_status: 'idle',
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(envelopes[0]!.volatile).toBeUndefined();
    expect(envelopes[1]).toMatchObject({ type: 'turn.started', seq: 2 });
  });

  it('emits a durable event.session.status_changed(idle) after turn.ended', async () => {
    // Regression: v2 derives session status via ISessionActivity (a pure pull)
    // and publishes nothing, and kimi-web's turn.ended projector deliberately
    // does NOT synthesize a status flip — the daemon's
    // `event.session.status_changed` is its only turn-end signal (it drives
    // onSessionIdle queue flush and clears the Stop/loading state). Without
    // this the session stayed `running` forever once a turn ended; most
    // visibly for background tasks, where ISessionActivity keeps reporting
    // non-idle while the detached task lives, so even a REST pull never
    // corrected it. Emitted after turn.ended (same queue) so the web finishes
    // the assistant message before flipping status.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({ type: 'turn.ended', seq: 3 });
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      seq: 4,
      session_id: 's1',
      payload: {
        type: 'event.session.status_changed',
        status: 'idle',
        previous_status: 'running',
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(envelopes[3]!.volatile).toBeUndefined();
  });

  it('emits event.session.status_changed(aborted) when a turn ends cancelled/failed/blocked', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'cancelled' }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((e) => e.type === 'event.session.status_changed');
    expect(statuses.map((e) => e.payload)).toMatchObject([
      { status: 'running', previous_status: 'idle' },
      { status: 'aborted', previous_status: 'running' },
    ]);
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

    expect(envelopes).toHaveLength(2);
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
    expect(envelopes[1]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'awaiting_question', previous_status: 'idle' },
    });
    expect(envelopes[0]!.volatile).toBeUndefined();

    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' }, method: 'enter' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.question.answered',
      seq: 3,
      session_id: 's1',
      payload: {
        question_id: 'q1',
        answers: { q_0: 'opt_0_0' },
      },
    });
    expect((envelopes[2]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'idle', previous_status: 'awaiting_question' },
    });
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
      'event.session.status_changed',
      'event.question.dismissed',
      'event.session.status_changed',
    ]);
    expect(envelopes[2]!.payload).toMatchObject({ question_id: 'q1' });
    expect((envelopes[2]!.payload as { dismissed_at?: string }).dismissed_at).toBeTypeOf('string');
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

    expect(envelopes).toHaveLength(2);
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
    expect(envelopes[1]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'awaiting_approval', previous_status: 'idle' },
    });

    lc.interactions.respond('a1', { decision: 'approved', scope: 'session' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.approval.resolved',
      seq: 3,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        decision: 'approved',
        scope: 'session',
      },
    });
    expect((envelopes[2]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'idle', previous_status: 'awaiting_approval' },
    });
  });

  it('keeps parallel interaction priority, dedupes status, and globally fans status out', async () => {
    const lc = new FakeLifecycle();
    lc.baseStatus = 'running';
    lc.addAgent('main');
    sessions.set('s1', lc);
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    });
    lc.interactions.enqueue({
      id: 'a1',
      kind: 'approval',
      payload: { toolName: 'Bash', action: 'run' },
    });
    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' } });
    await bc.getCursor('s1');

    expect(
      s1View.envelopes
        .filter((e) => e.type === 'event.session.status_changed')
        .map((e) => e.payload),
    ).toMatchObject([
      { status: 'awaiting_question', previous_status: 'running' },
      { status: 'awaiting_approval', previous_status: 'awaiting_question' },
    ]);
    // Resolving the question does not restore running while approval remains.
    expect(s1View.envelopes.at(-1)!.type).toBe('event.question.answered');
    expect(s2View.envelopes.map((e) => e.type)).toEqual([
      'event.session.status_changed',
      'event.session.status_changed',
    ]);

    lc.interactions.respond('a1', { decision: 'approved' });
    await bc.getCursor('s1');

    expect(s1View.envelopes.at(-1)).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'running', previous_status: 'awaiting_approval' },
    });
    expect(s2View.envelopes.at(-1)).toMatchObject({
      type: 'event.session.status_changed',
      session_id: 's1',
      payload: { status: 'running', previous_status: 'awaiting_approval' },
    });
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
    expect(envelopes.map((e) => e.type)).toEqual([
      'event.question.answered',
      'event.session.status_changed',
    ]);
    expect(envelopes[1]!.payload).toMatchObject({
      status: 'idle',
      previous_status: 'awaiting_question',
    });
  });

  it('fans out the legacy background.task.* alias alongside native task.* for v1 clients', async () => {
    // v2 emits `task.started`/`task.terminated`; unchanged v1 consumers
    // (kimi-code TUI / `kimi -p`, node-sdk) only understand
    // `background.task.*`. The broadcaster must emit both spellings so web
    // (handles `task.*`, ignores the alias) and TUI (handles the alias, ignores
    // `task.*`) both work without consumer changes.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    const info = { taskId: 't1', status: 'running', description: 'ls' };
    main.bus.emit(agentEvent('task.started', { info }));
    main.bus.emit(agentEvent('task.terminated', { info: { ...info, status: 'completed' } }));
    await bc.getCursor('s1');

    expect(envelopes.map((e) => e.type)).toEqual([
      'task.started',
      'background.task.started',
      'task.terminated',
      'background.task.terminated',
    ]);
    // Alias carries the same payload, stamped with agentId/sessionId.
    expect(envelopes[1]!.payload).toMatchObject({
      type: 'background.task.started',
      info,
      agentId: 'main',
      sessionId: 's1',
    });
    expect(envelopes[3]!.payload).toMatchObject({
      type: 'background.task.terminated',
      agentId: 'main',
      sessionId: 's1',
    });
    // Native durability is preserved and the alias mirrors it (both journaled,
    // monotonic seq), so reconnecting v1 clients rebuild task state from replay.
    expect(envelopes.every((e) => e.volatile === undefined)).toBe(true);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  // -------------------------------------------------------------------------
  // Per-agent subscription filter
  // -------------------------------------------------------------------------

  it('delivers only the allowlisted agent events on live fan-out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target, new Set(['main']));

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    // Agent events are filtered: only main's turn events are delivered.
    const agentEnvs = envelopes.filter((e) => e.type === 'turn.started' || e.type === 'turn.ended');
    expect(agentEnvs).toHaveLength(2);
    expect(
      agentEnvs.every((e) => (e.payload as { agentId: string }).agentId === 'main'),
    ).toBe(true);
    // `event.session.status_changed` is global (`event.session.*`) and bypasses
    // the agent filter. The redundant idle transition from the sub-agent is deduped.
    const statusEnvs = envelopes.filter((e) => e.type === 'event.session.status_changed');
    expect(statusEnvs).toHaveLength(2);
  });

  it('delivers every agent event when no filter is set', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target); // no filter — legacy behavior

    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const agentIds = envelopes
      .filter((e) => e.type === 'turn.ended')
      .map((e) => (e.payload as { agentId: string }).agentId);
    expect(agentIds).toEqual(['main', 'agent-0']);
  });

  it('bypasses the agent filter for global events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    // Filter does not include 'main', yet global events must still be delivered.
    await bc.subscribe('s1', target, new Set(['agent-0']));

    eventBus.emit({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试' },
      },
    });

    await vi.waitFor(() => expect(envelopes).toHaveLength(1));
    expect(envelopes[0]!.type).toBe('session.meta.updated');
  });

  it('replays only the allowlisted agent events while keeping the global sequence', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    // Dedicated broadcaster with a cap large enough to hold the full mixed
    // turn/status sequence before the filter crop is exercised.
    const dir2 = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    const bc2 = new SessionEventBroadcaster({
      eventsDir: dir2,
      core: makeCore(sessions, eventBus),
      maxBufferSize: 20,
    });
    try {
      // Activate the session and journal a mixed sequence before replaying.
      const warm = collectingTarget();
      await bc2.subscribe('s1', warm.target);
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
      main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
      await bc2.getCursor('s1');

      const result = await bc2.getBufferedSince('s1', { seq: 0 }, new Set(['main']));
      expect(result.resyncRequired).toBe(false);
      // The sub-agent's turn events are cropped, while global status transitions
      // retain their original positions in the session sequence.
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
      expect(
        result.events.every((e) => (e.envelope.payload as { agentId: string }).agentId === 'main'),
      ).toBe(true);
    } finally {
      await bc2.close();
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
