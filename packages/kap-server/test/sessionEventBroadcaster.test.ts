/**
 * `SessionEventBroadcaster` — seq stamping, volatile vs durable, fan-out, replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentActivityState,
  IScopeHandle,
  Scope,
  SessionActivityCause,
  SessionActivityChangedEvent,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  ContextSizeModel,
  IAgentActivityView,
  IAgentContextSizeService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentUsageService,
  IEventBus,
  IEventService,
  ISessionActivityView,
  ISessionInteractionService,
  ISessionLifecycleService,
  IWireService,
  ISessionMetadata,
  MAIN_AGENT_ID,
  SessionInteractionService,
} from '@moonshot-ai/agent-core-v2';
import type { AgentEvent } from '../src/transport/ws/v1/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';
import { TranscriptService } from '../src/services/transcript/transcriptService';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** The fake bus carries wire agent events and v2-internal ones alike. */
type FakeBusEvent = { type: string };

/**
 * Mirrors the production `EventBusService` dispatch contract: full-stream
 * subscribers fire first, per-type subscribers after — the ordering the
 * work_changed deferral relies on (the broadcaster's agent handler is a
 * full-stream subscriber; the activity view chain subscribes per-type, so
 * the view's change is reported AFTER the edge's own turn-frame handling).
 */
class FakeAgentBus {
  private allHandlers: Array<(e: FakeBusEvent) => void> = [];
  private perType = new Map<string, Array<(e: FakeBusEvent) => void>>();
  subscribe(handler: (e: FakeBusEvent) => void): { dispose(): void };
  subscribe(type: string, handler: (e: FakeBusEvent) => void): { dispose(): void };
  subscribe(typeOrHandler: string | ((e: FakeBusEvent) => void), handler?: (e: FakeBusEvent) => void) {
    if (typeof typeOrHandler === 'function') {
      this.allHandlers.push(typeOrHandler);
      return {
        dispose: () => {
          const i = this.allHandlers.indexOf(typeOrHandler);
          if (i >= 0) this.allHandlers.splice(i, 1);
        },
      };
    }
    const list = this.perType.get(typeOrHandler) ?? [];
    list.push(handler!);
    this.perType.set(typeOrHandler, list);
    return {
      dispose: () => {
        const i = list.indexOf(handler!);
        if (i >= 0) list.splice(i, 1);
      },
    };
  }
  emit(e: FakeBusEvent): void {
    for (const h of [...this.allHandlers]) h(e);
    for (const h of [...(this.perType.get(e.type) ?? [])]) h(e);
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
  private readonly services = new Map<unknown, unknown>();
  constructor(readonly id: string) {
    this.services.set(IEventBus, this.bus);
    this.accessor = {
      get: (token: unknown) => this.services.get(token),
    };
  }
  set(token: unknown, service: unknown): void {
    this.services.set(token, service);
  }
  dispose(): void {}
}

class FakeLifecycle {
  readonly handles: FakeAgentHandle[] = [];
  /** Real interaction kernel — served at the session accessor. */
  readonly interactions = new SessionInteractionService();
  /**
   * Mirrors the activity view's publication: every turn boundary re-emits an
   * `agent.activity.updated` on the same bus, nested inside the boundary
   * dispatch. Like the production `IAgentActivityView`, the subscriptions are
   * per-type — under the bus's two-phase dispatch they fire AFTER the
   * broadcaster's full-stream handler, exactly the production ordering the
   * work_changed deferral has to cope with.
   */
  private readonly turnCounters = new Map<string, { dispose(): void }>();
  private createHandlers: Array<(h: IScopeHandle) => void> = [];
  private disposeHandlers: Array<(id: string) => void> = [];
  list(): readonly FakeAgentHandle[] {
    return this.handles;
  }
  get(id: string): FakeAgentHandle | undefined {
    return this.getHandle(id);
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
    handle.set(IAgentActivityView, {
      state: () => ({ lifecycle: 'ready', background: [] }),
    });
    const onTurnStarted = handle.bus.subscribe('turn.started', (e) => {
      handle.bus.emit(
        agentEvent('agent.activity.updated', {
          lifecycle: 'ready',
          turn: {
            turnId: (e as { turnId?: number }).turnId,
            phase: 'running',
            step: 0,
            ending: false,
            pendingApprovals: [],
            activeToolCalls: [],
            since: 0,
          },
          background: [],
        }),
      );
    });
    const onTurnEnded = handle.bus.subscribe('turn.ended', (e) => {
      const ended = e as { turnId?: number; reason?: string };
      handle.bus.emit(
        agentEvent('agent.activity.updated', {
          lifecycle: 'ready',
          lastTurn: { turnId: ended.turnId, reason: ended.reason },
          background: [],
        }),
      );
    });
    this.turnCounters.set(id, {
      dispose: () => {
        onTurnStarted.dispose();
        onTurnEnded.dispose();
      },
    });
    this.handles.push(handle);
    for (const cb of this.createHandlers) cb(handle as unknown as IScopeHandle);
    return handle;
  }
  removeAgent(id: string): void {
    const idx = this.handles.findIndex((h) => h.id === id);
    if (idx >= 0) this.handles.splice(idx, 1);
    this.turnCounters.get(id)?.dispose();
    this.turnCounters.delete(id);
    for (const cb of this.disposeHandlers) cb(id);
  }
  /** Mirrors the core `ISessionActivityView` fold over the fake buses + kernel. */
  readonly workView = new FakeSessionActivityView(this);
}

/**
 * Test double for the core `ISessionActivityView`: mirrors the production
 * fold (per-agent activity + pending interactions → session aggregate with
 * cause-classified, deduped change events) over the harness's fake buses and
 * the real interaction kernel, so the broadcaster tests exercise the same
 * scheduling contract the real view provides.
 */
class FakeSessionActivityView {
  private readonly listeners = new Set<(change: SessionActivityChangedEvent) => void>();
  private readonly folds = new Map<
    string,
    { turnActive: boolean; background: number; lastTurnReason?: 'completed' | 'cancelled' | 'failed' }
  >();
  private readonly busSubscriptions = new Map<string, { dispose(): void }>();
  private readonly interactions: SessionInteractionService;
  private current: SessionActivityState;

  constructor(lifecycle: FakeLifecycle) {
    this.interactions = lifecycle.interactions;
    for (const handle of lifecycle.list()) this.attach(handle as unknown as FakeAgentHandle);
    lifecycle.onDidCreate((handle) => {
      this.attach(handle as unknown as FakeAgentHandle);
      this.recompute('agent_lifecycle');
    });
    lifecycle.onDidDispose((agentId) => {
      this.busSubscriptions.get(agentId)?.dispose();
      this.busSubscriptions.delete(agentId);
      if (this.folds.delete(agentId)) this.recompute('agent_lifecycle');
    });
    this.interactions.onDidChangePending(() => this.recompute('interaction'));
    this.current = this.aggregate();
  }

  state(): SessionActivityState {
    return this.current;
  }

  onDidChange(listener: (change: SessionActivityChangedEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private attach(handle: FakeAgentHandle): void {
    if (this.folds.has(handle.id)) return;
    const view = handle.accessor.get(IAgentActivityView) as
      | { state(): AgentActivityState }
      | undefined;
    this.folds.set(handle.id, this.foldOf(handle.id, view?.state()));
    this.busSubscriptions.set(
      handle.id,
      handle.bus.subscribe('agent.activity.updated', (event) => {
        this.onActivity(handle.id, event as unknown as AgentActivityState);
      }),
    );
  }

  private onActivity(agentId: string, snapshot: AgentActivityState): void {
    const previous = this.folds.get(agentId);
    const next = this.foldOf(agentId, snapshot, previous);
    this.folds.set(agentId, next);
    if (previous === undefined) {
      this.recompute('agent_lifecycle');
      return;
    }
    let cause: SessionActivityCause | undefined;
    if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background !== next.background) cause = 'background';
    else if (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason) {
      cause = 'turn_ended';
    }
    if (cause !== undefined) this.recompute(cause);
  }

  private foldOf(
    agentId: string,
    activity: AgentActivityState | undefined,
    previous?: { lastTurnReason?: 'completed' | 'cancelled' | 'failed' },
  ) {
    const reason = activity?.lastTurn?.reason;
    return {
      turnActive: activity?.turn !== undefined,
      background: activity?.background?.length ?? 0,
      lastTurnReason:
        agentId === MAIN_AGENT_ID
          ? reason === undefined
            ? undefined
            : reason === 'completed'
              ? 'completed'
              : reason === 'cancelled'
                ? 'cancelled'
                : 'failed'
          : previous?.lastTurnReason,
    };
  }

  private recompute(cause: SessionActivityCause): void {
    const next = this.aggregate();
    if (
      next.busy === this.current.busy &&
      next.mainTurnActive === this.current.mainTurnActive &&
      next.pendingInteraction === this.current.pendingInteraction &&
      next.lastTurnReason === this.current.lastTurnReason
    ) {
      return;
    }
    this.current = next;
    for (const listener of [...this.listeners]) listener({ state: next, cause });
  }

  private aggregate(): SessionActivityState {
    let busy = false;
    for (const fold of this.folds.values()) {
      if (fold.turnActive || fold.background > 0) {
        busy = true;
        break;
      }
    }
    const pending = this.interactions.listPending();
    return {
      busy,
      mainTurnActive: this.folds.get(MAIN_AGENT_ID)?.turnActive ?? false,
      pendingInteraction: pending.some((i) => i.kind === 'approval')
        ? 'approval'
        : pending.some((i) => i.kind === 'question')
          ? 'question'
          : 'none',
      lastTurnReason: this.folds.get(MAIN_AGENT_ID)?.lastTurnReason,
    };
  }
}

function makeCore(
  sessions: Map<string, FakeLifecycle>,
  eventBus = new FakeEventBus(),
  metaAgents: Record<string, { type?: string; parentAgentId?: string }> = {},
): Scope {
  const accessor = {
    get(token: unknown): unknown {
      if (token === IEventService) return eventBus;
      if (token === ISessionLifecycleService) {
        return {
          // Inert lifecycle events (TranscriptService subscribes on construction).
          onDidCloseSession: () => ({ dispose: () => {} }),
          onDidArchiveSession: () => ({ dispose: () => {} }),
          get: (sid: string) => {
            const lifecycle = sessions.get(sid);
            if (lifecycle === undefined) return undefined;
            const sessionAccessor = {
              get: (t: unknown) => {
                if (t === IAgentLifecycleService) return lifecycle;
                if (t === ISessionInteractionService) return lifecycle.interactions;
                if (t === ISessionActivityView) return lifecycle.workView;
                // Minimal metadata read for the transcript binding's descriptor pass.
                if (t === ISessionMetadata) return { read: async () => ({ agents: metaAgents }) };
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

// A real turn yields the event loop between `turn.started` and `turn.ended`,
// and the broadcaster aggregates the fold when each queued work_changed task
// runs. Back-to-back synchronous `bus.emit` calls never let the queue drain,
// so every aggregate read would observe the final state. Tests therefore
// `await bc.getCursor(...)` between turn boundaries to reproduce the
// production interleaving (book → publish → drain → release → publish).

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
    await bc.getCursor('s1'); // drain between the turn boundaries (see note above)
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1'); // drain

    // `turn.started` is trailed by a durable
    // `event.session.work_changed(busy:true)` and `turn.ended` by a durable
    // `work_changed(busy:false)` carrying the main turn outcome, hence four
    // durable events: turn.started, work_changed, turn.ended, work_changed.
    // (The volatile `agent.status.updated` phase frames projected from the
    // activity fold ride alongside and are excluded here.)
    const durable = envelopes.filter((e) => e.volatile !== true);
    expect(durable.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(durable[1]).toMatchObject({
      type: 'event.session.work_changed',
      payload: { busy: true, last_turn_reason: undefined, agentId: 'main', sessionId: 's1' },
    });
    expect(durable[3]).toMatchObject({
      type: 'event.session.work_changed',
      payload: { busy: false, last_turn_reason: 'completed' },
    });
    expect(envelopes.every((e) => e.epoch === envelopes[0]!.epoch)).toBe(true);
    expect(durable[1]!.volatile).toBeUndefined();
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

    const vol = envelopes.filter((e) => e.volatile === true && e.type === 'assistant.delta');
    expect(vol).toHaveLength(2);
    // `turn.started` takes seq 1 and the trailing durable work_changed takes
    // seq 2, so the volatile deltas ride the watermark at 2. (The volatile
    // agent.status.updated phase frame from the activity fold rides 1.)
    expect(vol.every((e) => e.seq === 2)).toBe(true); // rides the durable watermark
    expect(vol.map((e) => e.offset)).toEqual([0, 2]);
    expect((await bc.getCursor('s1')).seq).toBe(2); // seq did not advance
  });

  it('projects main-agent status and context changes into complete v1 status events', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    let contextSize = 10;
    const usage = {
      total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    main.set(IAgentContextSizeService, { get: () => ({ size: contextSize }) });
    main.set(IAgentProfileService, {
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
    });
    main.set(IAgentUsageService, { status: () => usage });
    main.set(IWireService, {
      getModel: (model: unknown) => {
        expect(model).toBe(ContextSizeModel);
        return { length: 0, tokens: 8 };
      },
    });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', { usage }));
    contextSize = 20;
    main.bus.emit(agentEvent('context.spliced', { start: 0, deleteCount: 0, messages: [] }));
    main.bus.emit(agentEvent('context.spliced', { start: 0, deleteCount: 0, messages: [] }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(2);
    expect(statuses.map((envelope) => envelope.payload)).toMatchObject([
      {
        type: 'agent.status.updated',
        usage,
        contextTokens: 10,
        maxContextTokens: 128_000,
        model: 'example-model',
      },
      {
        type: 'agent.status.updated',
        usage,
        contextTokens: 20,
        maxContextTokens: 128_000,
        model: 'example-model',
      },
    ]);
  });

  it('publishes the input cap as the status context limit when declared', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const usage = {
      byModel: {
        'example-model': { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      },
      total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    main.set(IAgentContextSizeService, { get: () => ({ size: 10 }) });
    main.set(IAgentProfileService, {
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000, max_input_tokens: 64_000 }),
    });
    main.set(IAgentUsageService, { status: () => usage });
    main.set(IWireService, {
      getModel: (model: unknown) => {
        expect(model).toBe(ContextSizeModel);
        return { length: 0, tokens: 8 };
      },
    });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', { usage }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses.map((envelope) => envelope.payload)).toMatchObject([
      { type: 'agent.status.updated', maxContextTokens: 64_000 },
    ]);
  });

  it('projects agent activity state into legacy running and ended phases', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        turn: {
          turnId: 1,
          origin: { kind: 'user' },
          phase: 'running',
          step: 1,
          ending: false,
          pendingApprovals: [],
          activeToolCalls: [],
          since: 100,
        },
      }),
    );
    main.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        lastTurn: { turnId: 1, reason: 'completed', at: 200 },
      }),
    );
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses.map((envelope) => envelope.payload)).toMatchObject([
      { phase: { kind: 'running', turnId: 1, step: 1 } },
      { phase: { kind: 'ended', turnId: 1, reason: 'completed' } },
    ]);
  });

  it('replays durable events since a cursor from the journal', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1'); // drain between the turn boundaries
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 1 });
    expect(result.resyncRequired).toBe(false);
    // seq 1 is turn.started; events after it are the durable work_changed
    // (busy) (2), turn.ended (3) and the durable work_changed(busy:false +
    // outcome) (4) emitted on turn end.
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
    await bc.getCursor('s1'); // seq = 6 (one deduplicated busy work_changed + five turns), maxBufferSize = 3

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
    // Let the lifecycle dispatch drain before driving the turn — a
    // synchronous emit would fold its activity ahead of the queued
    // work_changed task and reorder it in front of agent.created (see the
    // note above about the production interleaving).
    await bc.getCursor('s1');
    late.bus.emit(agentEvent('turn.started', { turnId: 7 }));
    await bc.getCursor('s1');

    // agent.created (seq 1) leads; turn.started (seq 2) is trailed by
    // work_changed(busy) (seq 3); the volatile agent.status.updated phase
    // frame rides alongside.
    expect(envelopes.filter((e) => e.volatile !== true).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(envelopes[0]).toMatchObject({ type: 'agent.created' });
    expect((envelopes[0]!.payload as { agentId: string }).agentId).toBe('main');
  });

  it('broadcasts agent.disposed only for agents this state attached', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.removeAgent('agent-0');
    // The creation-failure path fires onDidDispose for an agent that was
    // never created (and never attached) — clients must not hear about it.
    lc.removeAgent('ghost');
    await bc.getCursor('s1');

    const disposed = envelopes.filter((e) => e.type === 'agent.disposed');
    expect(disposed).toHaveLength(1);
    expect((disposed[0]!.payload as { agentId: string }).agentId).toBe('agent-0');
    expect(disposed[0]!.volatile).toBeUndefined(); // durable
  });

  it('delivers lifecycle events past the agent allowlist (session-grained)', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target, new Set(['main']));

    lc.addAgent('agent-0'); // outside the allowlist
    lc.removeAgent('agent-0');
    await bc.getCursor('s1');

    const types = envelopes.map((e) => e.type);
    expect(types).toContain('agent.created');
    expect(types).toContain('agent.disposed');
  });

  it('journals lifecycle events for replay', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.addAgent('agent-0');
    lc.removeAgent('agent-0');
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe(false);
    expect(result.events.map((e) => e.envelope.type)).toEqual([
      'agent.created',
      'agent.disposed',
    ]);
  });

  it('getSnapshotState returns the in-flight turn', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hello' }));
    const snap = await bc.getSnapshotState('s1');

    expect(snap.seq).toBe(2); // durable work_changed + turn.started advanced seq; the delta is volatile
    expect(snap.inFlightTurn).toMatchObject({ turn_id: 1, assistant_text: 'Hello' });
  });

  it('getSnapshotState returns the live subagent roster until the next main turn starts', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-1');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(
      agentEvent('subagent.spawned', {
        subagentId: 'agent-1',
        subagentName: 'kimi-subagent',
        parentToolCallId: 'tc_swarm_1',
        description: 'task agent-1',
        swarmIndex: 0,
        runInBackground: false,
      }),
    );
    main.bus.emit(agentEvent('subagent.started', { subagentId: 'agent-1' }));

    const mid = await bc.getSnapshotState('s1');
    expect(mid.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        description: 'task agent-1',
        subagent_phase: 'working',
        parent_tool_call_id: 'tc_swarm_1',
        swarm_index: 0,
        run_in_background: false,
      }),
    ]);

    // A subagent's own turn.ended must not wipe the roster mid-swarm.
    sub.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
    const still = await bc.getSnapshotState('s1');
    expect(still.subagents).toHaveLength(1);

    // The main turn.ended keeps the roster too: the swarm result may not be
    // durable in the wire transcript yet (async append).
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    const ended = await bc.getSnapshotState('s1');
    expect(ended.subagents).toHaveLength(1);

    // The next main turn.started settles the transcript — the roster is dropped.
    main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
    const next = await bc.getSnapshotState('s1');
    expect(next.subagents).toEqual([]);
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

  describe('global fan-out to unsubscribed connections', () => {
    it('delivers event.session.created to a global-only target that never subscribed', async () => {
      sessions.set('s1', new FakeLifecycle());

      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const session = { id: 's1', title: 't', status: 'idle' };
      eventBus.emit({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: 's1', session },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.session.created',
        session_id: 's1',
      });
    });

    it('delivers work_changed to a global-only target while a subscriber drives the session', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);

      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      // Someone else activates the session; the global-only target has no
      // subscription of its own yet still tracks the busy facts.
      const { target } = collectingTarget();
      await bc.subscribe('s1', target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await bc.getCursor('s1'); // drain between the turn boundaries
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await bc.getCursor('s1'); // drain

      const workChanged = globalView.envelopes.filter(
        (e) => e.type === 'event.session.work_changed',
      );
      expect(workChanged).toHaveLength(2);
      expect(workChanged[0]).toMatchObject({ session_id: 's1', payload: { busy: true } });
      expect(workChanged[1]).toMatchObject({
        session_id: 's1',
        payload: { busy: false, last_turn_reason: 'completed' },
      });
      // Fine-grained agent events stay subscribe-gated.
      expect(
        globalView.envelopes.filter((e) => e.type === 'turn.started'),
      ).toHaveLength(0);
    });

    it('stops delivering after removeGlobalTarget', async () => {
      sessions.set('s1', new FakeLifecycle());

      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);
      bc.removeGlobalTarget(globalView.target);

      eventBus.emit({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: 's1', session: { id: 's1' } },
      });
      await bc.getCursor('s1'); // drain

      expect(globalView.envelopes).toHaveLength(0);
    });

    it('delivers exactly one copy to a target that is both global and subscribed', async () => {
      sessions.set('s1', new FakeLifecycle());

      const both = collectingTarget();
      bc.addGlobalTarget(both.target);
      await bc.subscribe('s1', both.target);

      eventBus.emit({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: 's1', session: { id: 's1' } },
      });

      await vi.waitFor(() => expect(both.envelopes).toHaveLength(1));
      await bc.getCursor('s1'); // drain any would-be duplicate
      expect(both.envelopes).toHaveLength(1);
    });
  });

  it('emits a durable event.session.work_changed(busy) trailing turn.started', async () => {
    // Regression: the session's busy fact exists only as the agents' activity
    // state (nothing is published session-wide), so the WS stream never
    // carried the busy transition and kimi-web's Stop button never rendered.
    // The broadcaster re-emits the aggregate off the activity fold — under
    // the bus's two-phase dispatch the fold reports after the edge's own
    // turn.started handling, so the work_changed trails the turn frame on
    // the same queue.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');

    const durable = envelopes.filter((e) => e.volatile !== true);
    expect(durable).toHaveLength(2);
    expect(durable[0]).toMatchObject({ type: 'turn.started', seq: 1 });
    expect(durable[1]).toMatchObject({
      type: 'event.session.work_changed',
      seq: 2,
      session_id: 's1',
      payload: {
        type: 'event.session.work_changed',
        busy: true,
        last_turn_reason: undefined,
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(durable[1]!.volatile).toBeUndefined();
  });

  it('emits a durable event.session.work_changed after turn.ended with the main turn outcome', async () => {
    // Regression: kimi-web's turn.ended projector deliberately does NOT
    // synthesize a busy flip — the daemon's `event.session.work_changed` is
    // its only turn-end signal (it drives onSessionIdle queue flush and
    // clears the Stop/loading state). Without it the session stayed busy
    // forever once a turn ended. Emitted after turn.ended (same queue) so
    // the web finishes the assistant message before flipping busy off.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1'); // drain between the turn boundaries
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    const durable = envelopes.filter((e) => e.volatile !== true);
    expect(durable).toHaveLength(4);
    expect(durable[2]).toMatchObject({ type: 'turn.ended', seq: 3 });
    expect(durable[3]).toMatchObject({
      type: 'event.session.work_changed',
      seq: 4,
      session_id: 's1',
      payload: {
        type: 'event.session.work_changed',
        busy: false,
        last_turn_reason: 'completed',
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(durable[3]!.volatile).toBeUndefined();
  });

  it('maps the main turn outcome into last_turn_reason on the post-turn work_changed', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    for (const [turnId, reason] of [
      [1, 'cancelled'],
      [2, 'failed'],
      [3, 'blocked'],
    ] as const) {
      main.bus.emit(agentEvent('turn.started', { turnId }));
      await bc.getCursor('s1'); // drain between the turn boundaries
      main.bus.emit(agentEvent('turn.ended', { turnId, reason }));
      await bc.getCursor('s1');
    }

    const durable = envelopes.filter((e) => e.volatile !== true);
    expect(durable).toHaveLength(12); // 3 × (work_changed + turn.started + turn.ended + work_changed)
    const workChanged = durable.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged.map((e) => e.payload)).toMatchObject([
      { busy: true, last_turn_reason: undefined }, // a main turn.started clears the outcome
      { busy: false, last_turn_reason: 'cancelled' },
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'failed' },
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'failed' }, // 'blocked' folds into 'failed'
    ]);
  });

  it('flips busy from background tasks alone (no turn involved)', async () => {
    // The second busy layer: an agent with a live background task (e.g. a
    // detached Bash process) is busy even with no active turn. No turn
    // boundaries fire here — the fold emits work_changed straight off the
    // activity update.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        background: [{ kind: 'process', id: 'bash-1', since: 100 }],
      }),
    );
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('agent.activity.updated', { lifecycle: 'ready', background: [] }));
    await bc.getCursor('s1');

    const workChanged = envelopes.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged.map((e) => e.payload)).toMatchObject([
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: undefined },
    ]);
    // No turn, so the phase projection is `idle` — orthogonal to the busy
    // fact (idle phase + busy session is exactly "background work only").
    expect(envelopes.filter((e) => e.type === 'agent.status.updated').map((e) => e.payload))
      .toMatchObject([{ phase: { kind: 'idle' } }, { phase: { kind: 'idle' } }]);
  });

  it('emits the first background-work change from an agent created after activation', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    const late = lc.addAgent('agent-0');
    late.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        background: [{ kind: 'process', id: 'bash-1', since: 100 }],
      }),
    );
    await bc.getCursor('s1');

    const workChanged = envelopes.filter((event) => event.type === 'event.session.work_changed');
    expect(workChanged).toHaveLength(1);
    expect(workChanged[0]?.payload).toMatchObject({ busy: true });
  });

  it('reports the main turn ending while sub-agent background work keeps busy true', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    sub.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        background: [{ kind: 'process', id: 'bash-1', since: 100 }],
      }),
    );
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    const workChanged = envelopes.filter((event) => event.type === 'event.session.work_changed');
    expect(workChanged.map((event) => event.payload)).toMatchObject([
      { busy: true, main_turn_active: false },
      { busy: true, main_turn_active: true },
      { busy: true, main_turn_active: false, last_turn_reason: 'completed' },
    ]);
  });

  it('flips busy but never touches last_turn_reason from sub-agent turn boundaries', async () => {
    // A sub-agent's turn.started/turn.ended stream over the same session
    // channel with their own agentId. They DO drive `busy` (the drain registry
    // counts every agent), but only the MAIN agent feeds `last_turn_reason`:
    // a sub-agent's cancelled turn must not mark the session aborted, and its
    // work does not clear a pending outcome. While the main turn is in flight
    // the sub-agent's boundaries dedup to no-ops (busy stays true), so kimi-web
    // never reads them as "the turn finished" (browser notification,
    // completion sound, unread dot, queued message drain).
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1'); // drain between the turn boundaries
    // A foreground sub-agent runs and completes while the main turn is in flight.
    sub.bus.emit(agentEvent('turn.started', { turnId: 10 }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 10, reason: 'completed' }));
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');
    // A sub-agent-only turn after the main one: busy flips emit work_changed,
    // but the sub's cancelled outcome never lands in last_turn_reason.
    sub.bus.emit(agentEvent('turn.started', { turnId: 11 }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 11, reason: 'cancelled' }));
    await bc.getCursor('s1');

    // The sub-agent's turn events are still fanned out (clients render them in
    // the task view).
    expect(
      envelopes
        .filter((e) => e.type === 'turn.started' || e.type === 'turn.ended')
        .map((e) => (e.payload as { agentId: string }).agentId),
    ).toEqual(['main', 'agent-0', 'agent-0', 'main', 'agent-0', 'agent-0']);
    const workChanged = envelopes.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged.map((e) => e.payload)).toMatchObject([
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'completed' },
      { busy: true, last_turn_reason: 'completed' },
      { busy: false, last_turn_reason: 'completed' },
    ]);
    // The sub-agent's 'cancelled' never surfaces as the session outcome, and
    // the final busy flip fires exactly once, after the sub-agent's turn end.
    expect(
      workChanged.every(
        (e) => (e.payload as { last_turn_reason?: string }).last_turn_reason !== 'cancelled',
      ),
    ).toBe(true);
    expect(envelopes.at(-1)!.type).toBe('event.session.work_changed');
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
      type: 'event.session.work_changed',
      seq: 1,
      payload: { pending_interaction: 'question' },
    });
    expect(envelopes[1]).toMatchObject({
      type: 'event.question.requested',
      seq: 2,
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
    expect(envelopes[1]!.volatile).toBeUndefined();

    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' }, method: 'enter' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.session.work_changed',
      seq: 3,
      payload: { pending_interaction: 'none' },
    });
    expect(envelopes[3]).toMatchObject({
      type: 'event.question.answered',
      seq: 4,
      session_id: 's1',
      payload: {
        question_id: 'q1',
        answers: { q_0: 'opt_0_0' },
      },
    });
    expect((envelopes[3]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
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

    // The core work view announces each pending-slice change as it happens,
    // so a synchronous request+resolve still journals both transitions
    // (pending → none) instead of coalescing them away.
    expect(envelopes.map((e) => e.type)).toEqual([
      'event.session.work_changed',
      'event.question.requested',
      'event.session.work_changed',
      'event.question.dismissed',
    ]);
    expect(envelopes[0]!.payload).toMatchObject({ pending_interaction: 'question' });
    expect(envelopes[2]!.payload).toMatchObject({ pending_interaction: 'none' });
    expect(envelopes[3]!.payload).toMatchObject({ question_id: 'q1' });
    expect((envelopes[3]!.payload as { dismissed_at?: string }).dismissed_at).toBeTypeOf('string');
  });

  it('carries the requesting agent onto resolved interaction events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    lc.addAgent('sub-1');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'q-sub',
      kind: 'question',
      payload: {
        toolCallId: 'call_q',
        questions: [{ question: 'Pick', options: [{ label: 'A' }] }],
      },
      origin: { agentId: 'sub-1' },
    });
    await bc.getCursor('s1');
    expect(
      envelopes.find((e) => e.type === 'event.question.requested')?.payload,
    ).toMatchObject({ agentId: 'sub-1', question_id: 'q-sub' });

    lc.interactions.respond('q-sub', { answers: { q_0: 'opt_0_0' } });
    await bc.getCursor('s1');
    // The resolved event must keep the same agent — an agent-filtered
    // subscriber otherwise sees the question open but never close.
    expect(
      envelopes.find((e) => e.type === 'event.question.answered')?.payload,
    ).toMatchObject({ agentId: 'sub-1', question_id: 'q-sub' });
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
      type: 'event.session.work_changed',
      seq: 1,
      payload: { pending_interaction: 'approval' },
    });
    expect(envelopes[1]).toMatchObject({
      type: 'event.approval.requested',
      seq: 2,
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
    expect(envelopes[1]!.volatile).toBeUndefined();

    lc.interactions.respond('a1', { decision: 'approved', scope: 'session' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.session.work_changed',
      seq: 3,
      payload: { pending_interaction: 'none' },
    });
    expect(envelopes[3]).toMatchObject({
      type: 'event.approval.resolved',
      seq: 4,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        decision: 'approved',
        scope: 'session',
      },
    });
    expect((envelopes[3]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
  });

  it('fans event.session.work_changed out to every connection, bypassing agent filters', async () => {
    // `event.session.*` is a global event class: a work_changed journaled on
    // s1 reaches subscribers of other sessions, and subscribers whose agent
    // allowlist excludes 'main' (the work_changed payload is main-stamped but
    // is not an agent event) — same bypass as the retired status_changed.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target, new Set(['agent-0']));
    await bc.subscribe('s2', s2View.target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1'); // drain between the turn boundaries
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    for (const view of [s1View, s2View]) {
      expect(view.envelopes.map((e) => e.type)).toEqual([
        'event.session.work_changed',
        'event.session.work_changed',
      ]);
      expect(view.envelopes.every((e) => e.session_id === 's1')).toBe(true);
      expect(view.envelopes.map((e) => e.payload)).toMatchObject([
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: 'completed' },
      ]);
    }
    // The filter still crops main's own turn events from the filtered view.
    expect(s1View.envelopes.some((e) => e.type === 'turn.started')).toBe(false);
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
      'event.session.work_changed',
      'event.question.answered',
    ]);
    expect(envelopes[0]!.payload).toMatchObject({ pending_interaction: 'none' });
    expect(envelopes[1]!.payload).toMatchObject({ question_id: 'q0' });
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
    await bc.getCursor('s1'); // drain between the turn boundaries
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    // Agent events are filtered: only main's turn events are delivered.
    const agentEnvs = envelopes.filter((e) => e.type === 'turn.started' || e.type === 'turn.ended');
    expect(agentEnvs).toHaveLength(2);
    expect(
      agentEnvs.every((e) => (e.payload as { agentId: string }).agentId === 'main'),
    ).toBe(true);
    // `event.session.work_changed` is global (`event.session.*`) and bypasses
    // the agent filter. The sub-agent's turn.ended flips no busy bit (main's
    // turn already ended, dedup keeps the pair) and never sets the outcome, so
    // only the main agent's two transitions are delivered.
    const workChanged = envelopes.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged).toHaveLength(2);
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

    // Main's turn.ended also journals a work_changed carrying its outcome
    // (busy was already false, but the reason pair changed); the sub-agent's
    // turn.ended touches neither.
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
    // turn/work_changed sequence before the filter crop is exercised.
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
      await bc2.getCursor('s1'); // drain between the turn boundaries
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await bc2.getCursor('s1');
      sub.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await bc2.getCursor('s1');
      sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
      await bc2.getCursor('s1');
      main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
      await bc2.getCursor('s1');
      main.bus.emit(agentEvent('turn.ended', { turnId: 2, reason: 'completed' }));
      await bc2.getCursor('s1');

      const result = await bc2.getBufferedSince('s1', { seq: 0 }, new Set(['main']));
      expect(result.resyncRequired).toBe(false);
      // The sub-agent's turn events are cropped (seq 5/7); its busy flips
      // still journal work_changed (global, main-stamped — seq 6/8), which
      // survives the crop alongside the main agent's turns and transitions.
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 6, 8, 9, 10, 11, 12]);
      expect(
        result.events.every((e) => (e.envelope.payload as { agentId: string }).agentId === 'main'),
      ).toBe(true);
    } finally {
      await bc2.close();
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('fans each agent event out once when session activation calls race', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();

    await Promise.all([
      bc.subscribe('s1', target),
      bc.getSnapshotState('s1'),
      bc.getBufferedSince('s1', { seq: 0 }),
      bc.getCursor('s1'),
      bc.getSnapshotState('s1'),
    ]);
    // Make the target observable from whichever state won the activation race.
    // Before the single-flight fix, every losing state's leaked bus listener
    // still routed through that winning state and advanced its tracker again.
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'abc' }));
    await bc.getCursor('s1');

    expect(
      envelopes
        .filter((envelope) => envelope.type === 'assistant.delta')
        .map((envelope) => ({
          offset: envelope.offset,
          delta: (envelope.payload as { delta: string }).delta,
        })),
    ).toEqual([{ offset: 0, delta: 'abc' }]);
  });

  // -------------------------------------------------------------------------
  // Transcript streaming (volatile add-on; the durable event path is untouched)
  // -------------------------------------------------------------------------

  describe('transcript streaming', () => {
    function makeBroadcasterWithTranscript(
      metaAgents?: Record<string, { type?: string; parentAgentId?: string }>,
    ): SessionEventBroadcaster {
      const core = makeCore(sessions, eventBus, metaAgents);
      return new SessionEventBroadcaster({
        eventsDir: dir,
        core,
        maxBufferSize: 3,
        transcriptService: new TranscriptService({ homeDir: dir, core }),
      });
    }

    function transcriptEnvelopes(envelopes: readonly EventEnvelope[]): EventEnvelope[] {
      return envelopes.filter(
        (e) => e.type === 'transcript.reset' || e.type === 'transcript.ops',
      );
    }

    interface OpsPayload {
      agent_id: string;
      ops: Array<{ op: string }>;
    }

    it('sends transcript.reset on first subscription, then fans ops out filtered per grade', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const deltaView = collectingTarget();
      const blockView = collectingTarget();
      const turnView = collectingTarget();
      const plainView = collectingTarget();
      await bc.subscribe('s1', deltaView.target, undefined, { '*': 'delta' });
      await bc.subscribe('s1', blockView.target, undefined, { '*': 'block' });
      await bc.subscribe('s1', turnView.target, undefined, { '*': 'turn' });
      await bc.subscribe('s1', plainView.target); // no transcript spec — legacy client

      // Every graded connection got exactly one initial reset for 'main'; the
      // legacy connection got none. Resets are volatile and ride the watermark.
      for (const view of [deltaView, blockView, turnView]) {
        const resets = transcriptEnvelopes(view.envelopes);
        expect(resets).toHaveLength(1);
        expect(resets[0]).toMatchObject({
          type: 'transcript.reset',
          volatile: true,
          session_id: 's1',
          payload: { agent_id: 'main', has_more_older: false, snapshot: { items: [] } },
        });
      }
      expect(transcriptEnvelopes(plainView.envelopes)).toHaveLength(0);

      // turn.started → turn.upsert flows at every grade ≥ 'turn', trailed by
      // the status slice the activity fold projects as meta.merge (under the
      // two-phase dispatch the fold reports after the edge's own turn-frame
      // handling, so the meta batch lands last).
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      for (const view of [deltaView, blockView, turnView]) {
        const batches = transcriptEnvelopes(view.envelopes).slice(-2);
        for (const ops of batches) {
          expect(ops.type).toBe('transcript.ops');
          expect(ops.volatile).toBe(true);
        }
        expect(batches.map((ops) => (ops.payload as OpsPayload).ops.map((o) => o.op))).toEqual([
          ['turn.upsert'],
          ['meta.merge'],
        ]);
      }
      expect(transcriptEnvelopes(plainView.envelopes)).toHaveLength(0);

      // assistant.delta → frame.upsert + append flow at 'delta', the
      // frame.upsert alone flows at 'block', nothing flows at 'turn'.
      const turnBatchesBefore = transcriptEnvelopes(turnView.envelopes).length;
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' }));
      const deltaOps = transcriptEnvelopes(deltaView.envelopes).at(-1)!.payload as OpsPayload;
      expect(deltaOps.ops.map((o) => o.op)).toEqual(['frame.upsert', 'append']);
      const blockOps = transcriptEnvelopes(blockView.envelopes).at(-1)!.payload as OpsPayload;
      expect(blockOps.ops.map((o) => o.op)).toEqual(['frame.upsert']);
      expect(transcriptEnvelopes(turnView.envelopes)).toHaveLength(turnBatchesBefore);

      // step completion flushes the full-text frame — 'block' reconverges
      // without ever seeing an append.
      main.bus.emit(agentEvent('turn.step.completed', { turnId: 1, step: 1 }));
      const flushed = transcriptEnvelopes(blockView.envelopes).at(-1)!.payload as OpsPayload;
      expect(flushed.ops).toEqual([
        expect.objectContaining({
          op: 'frame.upsert',
          frame: expect.objectContaining({ kind: 'text', text: 'Hi' }),
        }),
        expect.objectContaining({ op: 'step.upsert' }),
      ]);
      // And the seq of every transcript frame is the current durable watermark.
      expect(transcriptEnvelopes(deltaView.envelopes).every((e) => e.volatile === true)).toBe(true);
    });

    it('re-sends transcript.reset on grade upgrade, not on equal or downgraded re-subscribe', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'turn' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      // Same grade — no new reset.
      await bc.subscribe('s1', view.target, undefined, { '*': 'turn' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      // Downgrade — no reset, and ops stop flowing above the new grade.
      await bc.subscribe('s1', view.target, undefined, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      // Upgrade — a fresh snapshot reset.
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(2);
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.reset');
    });

    it('seeds transcript.reset for agents appearing after the subscription (roster-driven)', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      const offView = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      await bc.subscribe('s1', offView.target, undefined, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1); // main reset

      // A sub-agent appears: the binding creates its transcript, the roster
      // listener fans a reset out to grade-matching connections only.
      const late = lc.addAgent('agent-0');
      const resets = transcriptEnvelopes(view.envelopes);
      expect(resets).toHaveLength(2);
      expect(resets.at(-1)).toMatchObject({
        type: 'transcript.reset',
        payload: { agent_id: 'agent-0' },
      });
      expect(transcriptEnvelopes(offView.envelopes)).toHaveLength(0);

      // The late agent's own events now stream too.
      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const ops = transcriptEnvelopes(view.envelopes).at(-1)!;
      expect(ops.type).toBe('transcript.ops');
      expect((ops.payload as OpsPayload).agent_id).toBe('agent-0');
    });

    it('streams for a client subscribed before any agent exists', async () => {
      const lc = new FakeLifecycle();
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // The roster is empty at subscribe time: no baseline is owed, but the
      // target must still count as seeded for what comes later.
      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });

      const main = lc.addAgent('main');
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      const types = transcriptEnvelopes(view.envelopes).map((e) => e.type);
      expect(types).toContain('transcript.reset');
      expect(types).toContain('transcript.ops');
    });

    it('keeps delivering ops across a no-reset resubscribe', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { main: 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const before = transcriptEnvelopes(view.envelopes).length;

      // Same grades, no upgrade: the stream must not black out while the
      // resubscribe's seed work is in flight.
      const resub = bc.subscribe('s1', view.target, undefined, { main: 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      await resub;

      const after = transcriptEnvelopes(view.envelopes);
      expect(after.length).toBeGreaterThan(before);
      expect(after.some((e) => e.type === 'transcript.ops')).toBe(true);
    });

    it('forces a baseline reset when a cursor-based resubscribe flushes at the same grade', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { main: 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1); // baseline

      // Cursor-based resubscribe at the same grade defers the baseline until
      // the caller's replay completes; ops fanned out meanwhile are dropped.
      await bc.subscribe('s1', view.target, undefined, { main: 'delta' }, { deferTranscriptReset: true });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      // The flush owes a full baseline even without a grade/filter change —
      // only a reset closes the gap left by the dropped ops.
      await bc.flushTranscriptSeed('s1', view.target);
      const resets = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.reset');
      expect(resets).toHaveLength(2);
    });

    it('backfills wildcard-admitted roster agents before seeding their baseline', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      // sub-1 exists only in the persisted session metadata: its descriptor
      // is seeded into the roster, but its transcript is not materialized
      // until something backfills it.
      bc = makeBroadcasterWithTranscript({ 'sub-1': { type: 'sub' } });

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      const ids = transcriptEnvelopes(view.envelopes)
        .filter((e) => e.type === 'transcript.reset')
        .map((e) => (e.payload as { agent_id: string }).agent_id)
        .sort();
      expect(ids).toEqual(['main', 'sub-1']);
    });

    it('sends no resets when the target downgrades while the seed is in flight', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(0);

      // The upgrade's seed work awaits history backfill; the downgrade lands
      // first, so the stale call must not answer with a delta reset.
      const pending = bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      await bc.subscribe('s1', view.target, undefined, { '*': 'off' });
      await pending;
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(0);
    });

    it('sends no resets when the target unsubscribes while the seed is in flight', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      const core = makeCore(sessions, eventBus, { 'sub-1': { type: 'sub' } });
      const service = new TranscriptService({ homeDir: dir, core });
      let releaseBackfill!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBackfill = resolve;
      });
      const original = service.ensureAgentHistory.bind(service);
      const backfillSpy = vi
        .spyOn(service, 'ensureAgentHistory')
        .mockImplementation(async (sessionId, agentId) => {
          if (agentId === 'sub-1') await gate;
          return original(sessionId, agentId);
        });
      bc = new SessionEventBroadcaster({
        eventsDir: dir,
        core,
        maxBufferSize: 3,
        transcriptService: service,
      });

      const view = collectingTarget();
      const pending = bc.subscribe('s1', view.target, undefined, { 'sub-1': 'delta' });
      // The target registers before the backfill starts — park the seed on the
      // gate, then drop the subscription while history is still loading.
      await vi.waitFor(() => {
        expect(backfillSpy).toHaveBeenCalledWith('s1', 'sub-1');
      });
      bc.unsubscribe('s1', view.target);
      releaseBackfill();
      await pending;
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(0);
    });

    it('reattaches the ops fan-out when the session store is rebuilt after a drop', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      const core = makeCore(sessions, eventBus);
      const service = new TranscriptService({ homeDir: dir, core });
      bc = new SessionEventBroadcaster({
        eventsDir: dir,
        core,
        maxBufferSize: 3,
        transcriptService: service,
      });

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const opsBefore = transcriptEnvelopes(view.envelopes).filter(
        (e) => e.type === 'transcript.ops',
      ).length;
      expect(opsBefore).toBeGreaterThan(0);

      // The engine session closes: the service drops the store and its ops
      // listener set, but the broadcaster's session state survives (same
      // daemon). A later subscribe rebuilds the store — and must re-register
      // the fan-out, not just reseed.
      service.dropSession('s1');
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));

      const opsAfter = transcriptEnvelopes(view.envelopes).filter(
        (e) => e.type === 'transcript.ops',
      ).length;
      expect(opsAfter).toBeGreaterThan(opsBefore);
    });

    it('delivers no transcript.ops before the baseline reset has landed', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // Activate the stream with a first subscriber.
      const first = collectingTarget();
      await bc.subscribe('s1', first.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      // A second subscriber joins while ops are flowing: its first transcript
      // frame must be the baseline reset, never mid-stream ops against an
      // empty baseline.
      const second = collectingTarget();
      const pending = bc.subscribe('s1', second.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      await pending;
      // After the seed, ops flow normally again.
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'y' }));

      const types = transcriptEnvelopes(second.envelopes).map((e) => e.type);
      expect(types[0]).toBe('transcript.reset');
      expect(types.indexOf('transcript.ops')).toBeGreaterThan(types.indexOf('transcript.reset'));
    });

    it('seeds transcript resets for every graded agent regardless of the agent filter', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      lc.addAgent('sub-1');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // Filtered to main, with a wildcard delta grade: the transcript channel
      // is governed by the grades alone — sub-1 is seeded too.
      const view = collectingTarget();
      await bc.subscribe('s1', view.target, new Set(['main']), { '*': 'delta' });
      const resets = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.reset');
      expect(resets.map((e) => (e.payload as { agent_id: string }).agent_id)).toEqual([
        'main',
        'sub-1',
      ]);

      // Widening the filter afterwards owes no transcript baseline: sub-1's
      // ops were never suppressed, and delta → delta is no grade upgrade.
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      expect(
        transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.reset'),
      ).toHaveLength(2);
    });

    it('delivers transcript frames past the agent filter', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // Filtered to main, with a wildcard delta grade: the allowlist still
      // gates session_event delivery (covered by the filter tests above) but
      // must NOT gate transcript frames.
      const view = collectingTarget();
      await bc.subscribe('s1', view.target, new Set(['main']), { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1); // main reset

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      // The turn start also folds `agent.activity.updated` (the fake bus
      // re-emits it), which the projector now maps to a meta.merge — hence
      // reset + meta.merge + turn.upsert.
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(3);

      // The subagent matches the wildcard grade but not the allowlist: its
      // roster reset and ops are delivered all the same.
      const sub = lc.addAgent('sub-1');
      sub.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const frames = transcriptEnvelopes(view.envelopes);
      expect(frames).toHaveLength(6); // + sub-1 reset, meta.merge, turn.upsert
      const subFrames = frames.filter(
        (e) => (e.payload as { agent_id?: string }).agent_id === 'sub-1',
      );
      expect(subFrames.map((e) => e.type)).toEqual([
        'transcript.reset',
        'transcript.ops',
        'transcript.ops',
      ]);
    });

    it('sends an items-empty baseline reset marking older history, with global state and the watermark', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // Build store content first (a full turn tree with step/frame detail).
      const full = collectingTarget();
      await bc.subscribe('s1', full.target, undefined, { main: 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'secret body' }));
      main.bus.emit(agentEvent('turn.step.completed', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

      // A late subscriber's baseline embeds no turns — history pages in over
      // REST — but still reports that older history exists, carries the
      // global state, and is stamped with the watermark seq.
      const late = collectingTarget();
      await bc.subscribe('s1', late.target, undefined, { main: 'turn' });
      const resets = transcriptEnvelopes(late.envelopes).filter((e) => e.type === 'transcript.reset');
      expect(resets).toHaveLength(1);
      const payload = resets[0]!.payload as {
        snapshot: {
          items: unknown[];
          tasks: unknown[];
          interactions: unknown[];
          attachments: unknown[];
          todos: unknown[];
          meta: unknown;
        };
        has_more_older: boolean;
        seq?: number;
      };
      expect(payload.snapshot.items).toEqual([]);
      expect(payload.has_more_older).toBe(true);
      expect(payload.seq).toBeTypeOf('number');
      // The global state still rides the baseline (empty here — no tasks or
      // interactions were emitted — but the fields are present).
      expect(payload.snapshot).toMatchObject({
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
      });
      expect(JSON.stringify(payload.snapshot)).not.toContain('secret body');
    });

    it('honours per-agent grade overrides over the wildcard', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'off', main: 'delta' });

      // Only main matches — and it does.
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.ops');

      // A new agent matches only the wildcard ('off') → no reset, no ops.
      // (The count is 3 by now: the turn start also folds an
      // `agent.activity.updated`, which the projector maps to a meta.merge.)
      const late = lc.addAgent('agent-0');
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(3);
      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(3);
    });

    it('stamps ops payloads with the batch seq and resets with the watermark', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      const reset = transcriptEnvelopes(view.envelopes)[0]!;
      expect(reset.type).toBe('transcript.reset');
      const watermark = (reset.payload as { seq?: number }).seq;
      expect(watermark).toBeTypeOf('number');

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

      const ops = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.ops');
      expect(ops.length).toBeGreaterThan(0);
      const seqs = ops.map((e) => (e.payload as { seq?: number }).seq);
      // Every batch seq is past the baseline watermark and strictly
      // increasing (a connection sees a grade-filtered subsequence of the
      // consecutive per-agent numbering).
      expect(seqs.every((seq) => seq !== undefined && seq > watermark!)).toBe(true);
      expect([...seqs].toSorted((a, b) => a! - b!)).toEqual(seqs);
      // The envelope-level seq stays the durable watermark — transcript
      // frames never advance it.
      expect(ops.every((e) => e.volatile === true && e.seq === reset.seq)).toBe(true);
    });

    it('replays journaled batches instead of a reset when transcript_since is covered', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // A first connection establishes state and observes the batch seqs.
      const first = collectingTarget();
      await bc.subscribe('s1', first.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const cursor = (
        transcriptEnvelopes(first.envelopes).at(-1)!.payload as { seq: number }
      ).seq;

      // More ops land while the client is away.
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'hi' }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

      // Reconnect with the covered cursor: exactly the missed batches replay
      // (grade-filtered, in seq order) and NO baseline reset is sent.
      const second = collectingTarget();
      await bc.subscribe('s1', second.target, undefined, { '*': 'delta' }, {
        transcriptSince: { main: cursor },
      });
      const frames = transcriptEnvelopes(second.envelopes);
      expect(frames.some((e) => e.type === 'transcript.reset')).toBe(false);
      const replayed = frames.filter((e) => e.type === 'transcript.ops');
      expect(replayed.length).toBeGreaterThan(0);
      const seqs = replayed.map((e) => (e.payload as { seq: number }).seq);
      expect(seqs.every((seq) => seq > cursor)).toBe(true);
      expect([...seqs].toSorted((a, b) => a - b)).toEqual(seqs);

      // The connection is seeded: live ops keep flowing after the replay.
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'again' }));
      expect(transcriptEnvelopes(second.envelopes).at(-1)!.type).toBe('transcript.ops');
    });

    it('replays nothing (and no reset) when transcript_since is already current', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const first = collectingTarget();
      await bc.subscribe('s1', first.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const cursor = (
        transcriptEnvelopes(first.envelopes).at(-1)!.payload as { seq: number }
      ).seq;

      const second = collectingTarget();
      await bc.subscribe('s1', second.target, undefined, { '*': 'delta' }, {
        transcriptSince: { main: cursor },
      });
      expect(transcriptEnvelopes(second.envelopes)).toHaveLength(0);
    });

    it('falls back to a watermarked reset when transcript_since is not covered', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const first = collectingTarget();
      await bc.subscribe('s1', first.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      // A cursor ahead of the watermark cannot be vouched for — the ordinary
      // baseline reset rides instead, stamped with the current watermark.
      const second = collectingTarget();
      await bc.subscribe('s1', second.target, undefined, { '*': 'delta' }, {
        transcriptSince: { main: 9999 },
      });
      const resets = transcriptEnvelopes(second.envelopes).filter(
        (e) => e.type === 'transcript.reset',
      );
      expect(resets).toHaveLength(1);
      const watermark = (resets[0]!.payload as { seq?: number }).seq;
      expect(watermark).toBeTypeOf('number');
      expect(
        (
          transcriptEnvelopes(first.envelopes).filter((e) => e.type === 'transcript.ops').at(-1)!
            .payload as { seq: number }
        ).seq,
      ).toBeLessThanOrEqual(watermark!);
    });

    it('suppresses transcript-projected session_events on graded connections only', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const graded = collectingTarget();
      const legacy = collectingTarget();
      await bc.subscribe('s1', graded.target, undefined, { '*': 'delta' });
      await bc.subscribe('s1', legacy.target); // no transcript spec — legacy client

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' }));
      main.bus.emit(agentEvent('tool.result', { turnId: 1, toolCallId: 'tc-1', output: 'ok' }));
      await bc.getCursor('s1');

      // The graded connection receives the transcript stream (reset + ops)…
      expect(transcriptEnvelopes(graded.envelopes).length).toBeGreaterThan(0);
      // …but none of the projected session_events — including the volatile
      // agent.status.updated phase frames folded from the activity view,
      // which the transcript carries as meta.merge.
      const gradedTypes = graded.envelopes.map((e) => e.type);
      expect(gradedTypes).not.toContain('turn.started');
      expect(gradedTypes).not.toContain('turn.step.started');
      expect(gradedTypes).not.toContain('assistant.delta');
      expect(gradedTypes).not.toContain('tool.result');
      expect(gradedTypes).not.toContain('agent.status.updated');

      // The legacy connection is untouched: every session_event still flows
      // and no transcript frames leak to it.
      const legacyTypes = legacy.envelopes.map((e) => e.type);
      expect(legacyTypes).toContain('turn.started');
      expect(legacyTypes).toContain('turn.step.started');
      expect(legacyTypes).toContain('assistant.delta');
      expect(legacyTypes).toContain('tool.result');
      expect(transcriptEnvelopes(legacy.envelopes)).toHaveLength(0);
    });

    it('keeps delivering lifecycle and global events to graded connections', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });

      // agent.created is durable, session-grained, and has no transcript
      // counterpart — it must survive suppression.
      const late = lc.addAgent('agent-0');
      await bc.getCursor('s1'); // drain the lifecycle dispatch
      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');

      const types = view.envelopes.map((e) => e.type);
      expect(types).toContain('agent.created');
      // The global durable work_changed(busy) rides alongside the turn…
      expect(types).toContain('event.session.work_changed');
      // …while the projected turn.started itself is suppressed.
      expect(types).not.toContain('turn.started');
    });

    it('suppresses per agent — agents outside the spec keep their session_events', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      // The spec covers main only; agent-0's effective grade is 'off'.
      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { main: 'delta' });

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');

      const turns = view.envelopes.filter((e) => e.type === 'turn.started');
      expect(turns.map((e) => (e.payload as { agentId: string }).agentId)).toEqual(['agent-0']);
    });

    it('filters the replayed backlog by transcript grades', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      await bc.subscribe('s1', collectingTarget().target);
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1'); // drain between the turn boundaries
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await bc.getCursor('s1');

      // The durable backlog is: turn.started seq 1, work_changed(busy) seq 2,
      // turn.ended seq 3, work_changed(busy:false + outcome) seq 4.
      const unfiltered = await bc.getBufferedSince('s1', { seq: 1 });
      expect(unfiltered.events.map((e) => e.envelope.type)).toEqual([
        'event.session.work_changed',
        'turn.ended',
        'event.session.work_changed',
      ]);

      // With a graded spec the projected events drop out and the retained
      // global events survive; the unfiltered read above proves the journal
      // itself keeps everything.
      const filtered = await bc.getBufferedSince('s1', { seq: 1 }, undefined, { '*': 'delta' });
      expect(filtered.events.map((e) => e.envelope.type)).toEqual([
        'event.session.work_changed',
        'event.session.work_changed',
      ]);

      // An all-'off' spec suppresses nothing.
      const offSpec = await bc.getBufferedSince('s1', { seq: 1 }, undefined, { '*': 'off' });
      expect(offSpec.events.map((e) => e.envelope.type)).toEqual(
        unfiltered.events.map((e) => e.envelope.type),
      );
    });

    it('unsubscribeTranscript detaches per agent: ops stop and legacy events resume for that agent only', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');
      // Both agents stream via transcript; their projected session_events are suppressed.
      expect(view.envelopes.map((e) => e.type)).not.toContain('turn.started');
      const opsBefore = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.ops');
      expect(new Set(opsBefore.map((e) => (e.payload as OpsPayload).agent_id))).toEqual(
        new Set(['main', 'agent-0']),
      );

      bc.unsubscribeTranscript('s1', view.target, ['main']);

      main.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      await bc.getCursor('s1');

      // The detached agent's legacy events flow again; the other agent's stay suppressed.
      const turns = view.envelopes.filter((e) => e.type === 'turn.started');
      expect(turns.map((e) => (e.payload as { agentId: string }).agentId)).toEqual(['main']);
      // And the ops stream keeps serving only the still-graded agent.
      const opsAfter = transcriptEnvelopes(view.envelopes)
        .filter((e) => e.type === 'transcript.ops')
        .slice(opsBefore.length);
      expect(opsAfter.length).toBeGreaterThan(0);
      expect(new Set(opsAfter.map((e) => (e.payload as OpsPayload).agent_id))).toEqual(
        new Set(['agent-0']),
      );
    });

    it('unsubscribeTranscript without agent ids detaches the whole stream; a re-subscribe re-seeds', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1); // baseline

      bc.unsubscribeTranscript('s1', view.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');
      // No new transcript frames, and the legacy events are back in full.
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);
      expect(view.envelopes.map((e) => e.type)).toContain('turn.started');

      // Re-subscribing is an upgrade over 'off' again: a fresh baseline lands.
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(2);
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.reset');
    });

    it('unsubscribeTranscript is idempotent and never activates a session', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      // Unknown session, unknown target, grade-less target — all no-ops.
      expect(() => bc.unsubscribeTranscript('nope', view.target)).not.toThrow();
      expect(() => bc.unsubscribeTranscript('s1', view.target)).not.toThrow();
      await bc.subscribe('s1', view.target);
      expect(() => bc.unsubscribeTranscript('s1', view.target, ['main'])).not.toThrow();
    });

    it('unsubscribeTranscript cancels a pending deferred baseline', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, undefined, { '*': 'delta' }, { deferTranscriptReset: true });
      bc.unsubscribeTranscript('s1', view.target);
      await bc.flushTranscriptSeed('s1', view.target);

      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(0);
    });
  });
});
