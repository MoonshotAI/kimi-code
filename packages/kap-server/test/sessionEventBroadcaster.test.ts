import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentActivityState,
  AgentContext,
  IScopeHandle,
  ISessionStateService,
  Scope,
  SessionActivityCause,
  SessionActivityChangedEvent,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentActivityView,
  LifecycleScope,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentScopeContext,
  IEventBus,
  IEventService,
  IModelCatalog,
  IModelService,
  ISessionActivityView,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionLifecycleService,
  ISessionManager,
  ISessionTokenCountingService,
  ISessionUsageService,
  IWorkspaceInstanceManager,
  IWorkspaceSessions,
  MAIN_AGENT_ID,
  makeAgentScopeContext,
  SessionInteractionService,
  StateRegistry,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { AgentEvent } from '../src/transport/ws/v1/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BroadcastDelivery,
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';
import { TranscriptService } from '../src/services/transcript/transcriptService';

class TestSessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

type FakeBusEvent = { type: string };

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
  readonly kind = LifecycleScope.Agent;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  readonly context: AgentContext;
  private readonly services = new Map<unknown, unknown>();
  constructor(readonly id: string) {
    const scope = makeAgentScopeContext({
      agentId: id,
      agentScope: `agents/${id}`,
      generation: 1,
    });
    this.context = scope.agentContext;
    this.services.set(IAgentScopeContext, scope);
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
  readonly interactions = new SessionInteractionService(new TestSessionStateService());
  private readonly turnCounters = new Map<string, { dispose(): void }>();
  private createHandlers: Array<(context: AgentContext) => void> = [];
  private disposeHandlers: Array<(context: AgentContext) => void> = [];
  list(): readonly FakeAgentHandle[] {
    return this.handles;
  }
  get(context: AgentContext): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === context.agentId);
  }
  getHandle(id: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === id);
  }
  findAgentHandle(agentId: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === agentId);
  }
  onDidCreate(h: (context: AgentContext) => void) {
    this.createHandlers.push(h);
    return { dispose: () => {} };
  }
  onDidDispose(h: (context: AgentContext) => void) {
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
    for (const cb of this.createHandlers) cb(handle.context);
    return handle;
  }
  removeAgent(id: string): void {
    const idx = this.handles.findIndex((h) => h.id === id);
    const [removed] = idx >= 0 ? this.handles.splice(idx, 1) : [];
    this.turnCounters.get(id)?.dispose();
    this.turnCounters.delete(id);
    if (removed !== undefined) {
      for (const cb of this.disposeHandlers) cb(removed.context);
    }
  }
  readonly workView = new FakeSessionActivityView(this);
}

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
    lifecycle.onDidCreate((context) => {
      const handle = lifecycle.get(context);
      if (handle !== undefined) this.attach(handle as unknown as FakeAgentHandle);
      this.recompute('agent_lifecycle');
    });
    lifecycle.onDidDispose((context) => {
      const agentId = context.agentId;
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
  const sessionFor = (sid: string) => {
    const lifecycle = sessions.get(sid);
    if (lifecycle === undefined) return undefined;
    const sessionAccessor = {
      get: (t: unknown) => {
        if (t === IAgentLifecycleService) return lifecycle;
        if (t === ISessionInteractionService) return lifecycle.interactions;
        if (t === ISessionActivityView) return lifecycle.workView;
        if (t === ISessionMetadata) return { read: async () => ({ agents: metaAgents }) };
        return undefined;
      },
    };
    return { id: sid, kind: LifecycleScope.Session, accessor: sessionAccessor, dispose: () => {} };
  };
  const sessionLifecycle = {
    onDidCloseSession: () => ({ dispose: () => {} }),
    onDidArchiveSession: () => ({ dispose: () => {} }),
    get: sessionFor,
  };
  const handler = {
    id: 'wd',
    kind: 'program',
    accessor: {
      get: (t: unknown) => (t === ISessionLifecycleService ? sessionLifecycle : undefined),
    },
    dispose: () => {},
  };
  const accessor = {
    get(token: unknown): unknown {
      if (token === IEventService) return eventBus;
      if (token === ISessionManager) {
        return {
          get: sessionFor,
          list: () => [...sessions.keys()].map((sessionId) => sessionFor(sessionId)),
        };
      }
      if (token === IWorkspaceInstanceManager) {
        return {
          list: () => [{ program: { accessor: handler.accessor } }],
          onDidChange: () => ({ dispose: () => {} }),
        };
      }
      if (token === IWorkspaceSessions) {
        return { listRecent: async () => [], count: async () => 3 };
      }
      return undefined;
    },
  };
  return { accessor } as unknown as Scope;
}

function agentEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as unknown as AgentEvent;
}

function collectingTarget(): {
  target: BroadcastTarget;
  envelopes: EventEnvelope[];
  deliveries: BroadcastDelivery[];
} {
  const envelopes: EventEnvelope[] = [];
  const deliveries: BroadcastDelivery[] = [];
  return {
    target: {
      send: (envelope, delivery = 'subscription') => {
        envelopes.push(envelope);
        deliveries.push(delivery);
      },
    },
    envelopes,
    deliveries,
  };
}

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

  it('preserves a real Event2 time in payload and derives the envelope timestamp from it', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);
    const event = new TurnStarted(
      { agentId: 'main', turnId: 1, origin: { kind: 'user' } },
      1_700_000_000_123,
    );

    main.bus.emit(event);
    await bc.getCursor('s1');

    const envelope = envelopes.find((candidate) => candidate.type === 'turn.started');
    expect(envelope?.timestamp).toBe(new Date(event.time).toISOString());
    expect(envelope?.payload).toMatchObject({
      type: 'turn.started',
      time: event.time,
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 's1',
    });
  });

  it('stamps monotonic seq on durable events and fans out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);

    const { target, envelopes, deliveries } = collectingTarget();
    expect(await bc.subscribe('s1', target)).toBe(true);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

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
    expect(
      envelopes.flatMap((envelope, index) =>
        envelope.volatile === true ? [] : [[envelope.type, deliveries[index]]],
      ),
    ).toEqual([
      ['turn.started', 'subscription'],
      ['event.session.work_changed', 'immediate'],
      ['turn.ended', 'subscription'],
      ['event.session.work_changed', 'immediate'],
    ]);
  });

  it('fans out volatile events with the current watermark + offset, not journaled', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: ' there' }));
    await bc.getCursor('s1');

    const vol = envelopes.filter((e) => e.volatile === true && e.type === 'assistant.delta');
    expect(vol).toHaveLength(2);
    expect(vol.every((e) => e.seq === 2)).toBe(true);
    expect(vol.map((e) => e.offset)).toEqual([0, 2]);
    expect((await bc.getCursor('s1')).seq).toBe(2);
  });

  it('projects main-agent status and context changes into complete v1 status events', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    let contextSize = 10;
    const usage = {
      total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    main.set(ISessionTokenCountingService, {
      statusSize: () => contextSize,
    });
    main.set(IAgentProfileService, {
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
    });
    main.set(ISessionUsageService, { status: () => usage });
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

  it('folds the legacy status snapshot into subagent status events too', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    const sub = lc.addAgent('agent-1');
    const usage = {
      total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    sub.set(ISessionTokenCountingService, { statusSize: () => 10 });
    sub.set(IAgentProfileService, {
      getModel: () => 'sub-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
    });
    sub.set(ISessionUsageService, { status: () => usage });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    sub.bus.emit(agentEvent('agent.status.updated', { usage }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.payload).toMatchObject({
      type: 'agent.status.updated',
      agentId: 'agent-1',
      usage,
      contextTokens: 10,
      maxContextTokens: 128_000,
      model: 'sub-model',
    });
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
    main.set(ISessionTokenCountingService, { statusSize: () => 10 });
    main.set(IAgentProfileService, {
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000, max_input_tokens: 64_000 }),
    });
    main.set(ISessionUsageService, { status: () => usage });
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

  it('omits maxContextTokens instead of pushing 0 when the context limit is unknown', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    main.set(ISessionTokenCountingService, { statusSize: () => 10 });
    main.set(IAgentProfileService, {
      getModel: () => 'ghost-model',
      getModelCapabilities: () => ({ max_context_tokens: 0 }),
    });
    main.set(ISessionUsageService, { status: () => ({}) });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', {}));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(1);
    const payload = statuses[0]!.payload as Record<string, unknown>;
    expect(payload['maxContextTokens']).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('maxContextTokens');
  });

  it('falls back to the default model limit when no model is bound', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    main.set(ISessionTokenCountingService, { statusSize: () => 10 });
    main.set(IAgentProfileService, {
      getModel: () => '',
      getModelCapabilities: () => ({ max_context_tokens: 0 }),
    });
    main.set(ISessionUsageService, { status: () => ({}) });
    main.set(IModelService, { getDefaultModel: () => 'default-model' });
    main.set(IModelCatalog, {
      get: (id: string) => {
        expect(id).toBe('default-model');
        return { capabilities: { max_context_tokens: 200_000 } };
      },
    });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', {}));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.payload).toMatchObject({ maxContextTokens: 200_000, model: '' });
  });

  it('omits maxContextTokens when no model is bound and no default model resolves', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    main.set(ISessionTokenCountingService, { statusSize: () => 10 });
    main.set(IAgentProfileService, {
      getModel: () => '',
      getModelCapabilities: () => ({ max_context_tokens: 0 }),
    });
    main.set(ISessionUsageService, { status: () => ({}) });
    main.set(IModelService, { getDefaultModel: () => 'removed-model' });
    main.set(IModelCatalog, {
      get: () => {
        throw new Error('unknown model');
      },
    });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', {}));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(1);
    expect(JSON.stringify(statuses[0]!.payload)).not.toContain('maxContextTokens');
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
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 1 });
    expect(result.resyncRequired).toBe(false);
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
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe('buffer_overflow');
    expect(result.currentSeq).toBe(6);
  });

  const TURN_STARTED_WIRE_KEYS = ['agentId', 'origin', 'prompt', 'sessionId', 'turnId', 'type'];

  it('forwards the promptId echo on a prompt-opened turn.started (live)', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(
      agentEvent('turn.started', {
        turnId: 1,
        origin: { kind: 'user' },
        prompt: 'with an exact id',
        promptId: 'submission-1',
      }),
    );
    await bc.getCursor('s1');

    const live = envelopes.find((e) => e.type === 'turn.started');
    expect(live).toBeDefined();
    expect(live!.payload).toHaveProperty('promptId', 'submission-1');
    expect(Object.keys(live!.payload as Record<string, unknown>).toSorted()).toEqual(
      [...TURN_STARTED_WIRE_KEYS, 'promptId'].toSorted(),
    );
  });

  it('keeps a video-prompt turn.started wire payload at the pre-attachment field set (live + disk-journal replay)', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(
      agentEvent('turn.started', {
        turnId: 1,
        origin: { kind: 'user' },
        prompt: 'summarize this clip',
        promptAttachments: [{ kind: 'video', fileId: 'file_vid_1' }],
      }),
    );
    await bc.getCursor('s1');

    const live = envelopes.find(
      (e) => e.type === 'turn.started' && (e.payload as { turnId?: number }).turnId === 1,
    );
    expect(live).toBeDefined();
    expect(live!.payload).not.toHaveProperty('promptAttachments');
    expect(Object.keys(live!.payload as Record<string, unknown>).toSorted()).toEqual(
      TURN_STARTED_WIRE_KEYS,
    );

    await bc.close();
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      core: makeCore(sessions, eventBus),
      maxBufferSize: 20,
    });
    const replay = await bc.getBufferedSince('s1', { seq: 0 });
    expect(replay.resyncRequired).toBe(false);
    const replayed = replay.events.find(
      (e) =>
        e.envelope.type === 'turn.started' &&
        (e.envelope.payload as { turnId?: number }).turnId === 1,
    );
    expect(replayed).toBeDefined();
    expect(replayed!.envelope.payload).not.toHaveProperty('promptAttachments');
    expect(Object.keys(replayed!.envelope.payload as Record<string, unknown>).toSorted()).toEqual(
      TURN_STARTED_WIRE_KEYS,
    );
  });

  it.each(['prompt.steered', 'prompt.queued'])(
    'projects %s content without leaking daemon refs (live + tail replay)',
    async (type) => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      const { target, envelopes } = collectingTarget();
      await bc.subscribe('s1', target);

      const ids =
        type === 'prompt.steered'
          ? { activePromptId: 'p1', promptIds: ['p2'], steeredAt: '2026-01-01T00:00:02.000Z' }
          : { promptId: 'p2', queueLength: 1 };
      main.bus.emit(
        agentEvent(type, {
          ...ids,
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image_url',
              imageUrl: { url: 'kimi-file://f_img1?path=%2Fabs%2Fsession%2Fmedia%2Ff_img1.png' },
            },
          ],
        }),
      );
      await bc.getCursor('s1');

      const expected = [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { kind: 'session_media', file_id: 'f_img1' } },
      ];
      const live = envelopes.find((e) => e.type === type);
      expect(live).toBeDefined();
      expect((live!.payload as { content: unknown }).content).toEqual(expected);
      expect(JSON.stringify(live!.payload)).not.toContain('kimi-file://');
      expect(JSON.stringify(live!.payload)).not.toContain('/abs/session');

      const replay = await bc.getBufferedSince('s1', { seq: 0 });
      const replayed = replay.events.find((e) => e.envelope.type === type);
      expect(replayed).toBeDefined();
      expect((replayed!.envelope.payload as { content: unknown }).content).toEqual(expected);
    },
  );

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

    const late = lc.addAgent('main');
    await bc.getCursor('s1');
    late.bus.emit(agentEvent('turn.started', { turnId: 7 }));
    await bc.getCursor('s1');

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
    lc.removeAgent('ghost');
    await bc.getCursor('s1');

    const disposed = envelopes.filter((e) => e.type === 'agent.disposed');
    expect(disposed).toHaveLength(1);
    expect((disposed[0]!.payload as { agentId: string }).agentId).toBe('agent-0');
    expect(disposed[0]!.volatile).toBeUndefined();
  });

  it('delivers lifecycle events past the agent allowlist (session-grained)', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target, new Set(['main']));

    lc.addAgent('agent-0');
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

    expect(snap.seq).toBe(2);
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
        model: 'provider/secondary',
        thinkingEffort: 'low',
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
        model: 'provider/secondary',
        thinking_effort: 'low',
      }),
    ]);

    sub.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
    const still = await bc.getSnapshotState('s1');
    expect(still.subagents).toHaveLength(1);

    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    const ended = await bc.getSnapshotState('s1');
    expect(ended.subagents).toHaveLength(1);

    main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
    const next = await bc.getSnapshotState('s1');
    expect(next.subagents).toEqual([]);
  });

  it('subscribe returns false for an unknown session', async () => {
    const { target } = collectingTarget();
    expect(await bc.subscribe('nope', target)).toBe(false);
  });

  it('broadcasts session.meta.updated under the real session id and fans out to every connection', async () => {
    sessions.set('s1', new FakeLifecycle());

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
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('broadcasts event.session.created under the real session id and fans out to every connection', async () => {
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
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('fans out event.session.archived to every connection, including for cold sessions', async () => {
    const globalView = collectingTarget();
    bc.addGlobalTarget(globalView.target);

    eventBus.emit({
      type: 'event.session.archived',
      payload: { sessionId: 'cold-1', workspaceId: 'wd_cold' },
    });

    await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
    expect(globalView.envelopes[0]).toMatchObject({
      type: 'event.session.archived',
      session_id: '__global__',
      payload: {
        type: 'event.session.archived',
        agentId: 'main',
        sessionId: 'cold-1',
        workspace_id: 'wd_cold',
      },
    });
    expect(globalView.deliveries).toEqual(['immediate']);
  });

  it('fans out event.workspace.created/updated with the wire workspace shape', async () => {
    const globalView = collectingTarget();
    bc.addGlobalTarget(globalView.target);

    const workspace = {
      id: 'wd_a',
      root: '/repo/a',
      name: 'repo-a',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    eventBus.emit({ type: 'event.workspace.created', payload: { workspace } });

    await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
    expect(globalView.envelopes[0]).toMatchObject({
      type: 'event.workspace.created',
      session_id: '__global__',
      payload: {
        type: 'event.workspace.created',
        agentId: 'main',
        sessionId: '__global__',
        workspace: {
          id: 'wd_a',
          root: '/repo/a',
          name: 'repo-a',
          created_at: new Date(1_000).toISOString(),
          last_opened_at: new Date(2_000).toISOString(),
          session_count: 3,
        },
      },
    });

    eventBus.emit({
      type: 'event.workspace.updated',
      payload: { workspace: { ...workspace, name: 'renamed' } },
    });
    await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(2));
    expect(globalView.envelopes[1]).toMatchObject({
      type: 'event.workspace.updated',
      payload: {
        type: 'event.workspace.updated',
        workspace: { id: 'wd_a', name: 'renamed', session_count: 3 },
      },
    });
    expect(globalView.deliveries).toEqual(['immediate', 'immediate']);
  });

  it('fans out event.workspace.deleted with the workspace id and root', async () => {
    const globalView = collectingTarget();
    bc.addGlobalTarget(globalView.target);

    eventBus.emit({
      type: 'event.workspace.deleted',
      payload: { workspaceId: 'wd_a', root: '/repo/a' },
    });

    await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
    expect(globalView.envelopes[0]).toMatchObject({
      type: 'event.workspace.deleted',
      session_id: '__global__',
      payload: {
        type: 'event.workspace.deleted',
        agentId: 'main',
        sessionId: '__global__',
        workspace_id: 'wd_a',
        root: '/repo/a',
      },
    });
  });

  it('gates event.di.unit_changed to connections opted into the DI debug feed', async () => {
    const plainView = collectingTarget();
    bc.addGlobalTarget(plainView.target);
    const diView = collectingTarget();
    bc.addGlobalTarget(diView.target);
    bc.addDiEventTarget(diView.target);

    eventBus.emit({
      type: 'event.di.unit_changed',
      payload: { scope: 'app', token: 'debugCascadeService', state: 'Active' },
    });

    await vi.waitFor(() => expect(diView.envelopes).toHaveLength(1));
    expect(diView.envelopes[0]).toMatchObject({
      type: 'event.di.unit_changed',
      session_id: '__global__',
      volatile: true,
      payload: {
        type: 'event.di.unit_changed',
        scope: 'app',
        token: 'debugCascadeService',
        state: 'Active',
        agentId: 'main',
        sessionId: '__global__',
      },
    });
    expect(diView.deliveries).toEqual(['immediate']);
    expect(plainView.envelopes).toHaveLength(0);

    eventBus.emit({
      type: 'event.di.unit_changed',
      payload: { scope: 'app', token: 'x', state: 'Exploded' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(diView.envelopes).toHaveLength(1);

    bc.removeGlobalTarget(diView.target);
    eventBus.emit({
      type: 'event.di.unit_changed',
      payload: { scope: 'app', token: 'debugCascadeService', state: 'Unloading' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(diView.envelopes).toHaveLength(1);
    expect(plainView.envelopes).toHaveLength(0);
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
      expect(globalView.deliveries).toEqual(['immediate']);
    });

    it('delivers work_changed to a global-only target while a subscriber drives the session', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);

      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const { target } = collectingTarget();
      await bc.subscribe('s1', target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await bc.getCursor('s1');
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await bc.getCursor('s1');

      const workChanged = globalView.envelopes.filter(
        (e) => e.type === 'event.session.work_changed',
      );
      expect(workChanged).toHaveLength(2);
      expect(workChanged[0]).toMatchObject({ session_id: 's1', payload: { busy: true } });
      expect(workChanged[1]).toMatchObject({
        session_id: 's1',
        payload: { busy: false, last_turn_reason: 'completed' },
      });
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
      await bc.getCursor('s1');

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
      await bc.getCursor('s1');
      expect(both.envelopes).toHaveLength(1);
    });

    it('delivers event.config.warning to a global-only target that never subscribed', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const warnings = [
        {
          domain: 'loopControl',
          message:
            "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'.",
        },
        { message: 'Environment variable OLD_VAR is deprecated; use NEW_VAR instead.' },
      ];
      eventBus.emit({ type: 'event.config.warning', payload: { warnings } });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.config.warning',
        session_id: '__global__',
        payload: { warnings },
      });
      expect(globalView.deliveries).toEqual(['immediate']);
    });

    it('fans out event.plugin.changed and event.capability.changed to global targets', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      eventBus.emit({ type: 'event.plugin.changed', payload: {} });
      eventBus.emit({
        type: 'event.capability.changed',
        payload: {
          capability_id: 'kimi-webbridge',
          install: { running: true, step: 'download', percent: 42 },
        },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(2));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.plugin.changed',
        session_id: '__global__',
      });
      expect(globalView.envelopes[1]).toMatchObject({
        type: 'event.capability.changed',
        session_id: '__global__',
        payload: {
          capability_id: 'kimi-webbridge',
          install: { running: true, step: 'download', percent: 42 },
        },
      });
      expect(globalView.envelopes[0]!.volatile).toBeUndefined();
      expect(globalView.envelopes[1]!.volatile).toBe(true);
    });

    it('drops malformed event.capability.changed payloads', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      eventBus.emit({ type: 'event.capability.changed', payload: null });
      eventBus.emit({
        type: 'event.capability.changed',
        payload: { capability_id: 7, install: { running: true } },
      });
      eventBus.emit({
        type: 'event.capability.changed',
        payload: { capability_id: 'kimi-cu' },
      });

      eventBus.emit({
        type: 'event.capability.changed',
        payload: { capability_id: 'kimi-cu', install: { running: false } },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.capability.changed',
        payload: { capability_id: 'kimi-cu', install: { running: false } },
      });
    });

    it('drops malformed event.config.warning payloads', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      eventBus.emit({ type: 'event.config.warning', payload: { warnings: [{ message: 42 }] } });
      eventBus.emit({ type: 'event.config.warning', payload: { warnings: 'nope' } });
      eventBus.emit({ type: 'event.config.warning', payload: null });

      const warnings = [{ message: 'something deprecated' }];
      eventBus.emit({ type: 'event.config.warning', payload: { warnings } });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.config.warning',
        payload: { warnings },
      });
    });
  });

  it('emits a durable event.session.work_changed(busy) trailing turn.started', async () => {
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
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
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
      await bc.getCursor('s1');
      main.bus.emit(agentEvent('turn.ended', { turnId, reason }));
      await bc.getCursor('s1');
    }

    const durable = envelopes.filter((e) => e.volatile !== true);
    expect(durable).toHaveLength(12);
    const workChanged = durable.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged.map((e) => e.payload)).toMatchObject([
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'cancelled' },
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'failed' },
      { busy: true, last_turn_reason: undefined },
      { busy: false, last_turn_reason: 'failed' },
    ]);
  });

  it('flips busy from background tasks alone (no turn involved)', async () => {
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
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.started', { turnId: 10 }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 10, reason: 'completed' }));
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.started', { turnId: 11 }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 11, reason: 'cancelled' }));
    await bc.getCursor('s1');

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
    lc.interactions.respond('q1', null);
    await bc.getCursor('s1');

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
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target, new Set(['agent-0']));
    await bc.subscribe('s2', s2View.target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
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
    expect(s1View.envelopes.some((e) => e.type === 'turn.started')).toBe(false);
  });

  it('does not re-announce interactions already pending at activation, but still broadcasts their resolution', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
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
    expect(envelopes.every((e) => e.volatile === undefined)).toBe(true);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('delivers only the allowlisted agent events on live fan-out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target, new Set(['main']));

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const agentEnvs = envelopes.filter((e) => e.type === 'turn.started' || e.type === 'turn.ended');
    expect(agentEnvs).toHaveLength(2);
    expect(
      agentEnvs.every((e) => (e.payload as { agentId: string }).agentId === 'main'),
    ).toBe(true);
    const workChanged = envelopes.filter((e) => e.type === 'event.session.work_changed');
    expect(workChanged).toHaveLength(2);
  });

  it('delivers every agent event when no filter is set', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

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

    const dir2 = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    const bc2 = new SessionEventBroadcaster({
      eventsDir: dir2,
      core: makeCore(sessions, eventBus),
      maxBufferSize: 20,
    });
    try {
      const warm = collectingTarget();
      await bc2.subscribe('s1', warm.target);
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await bc2.getCursor('s1');
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
      await bc.subscribe('s1', plainView.target);

      for (const view of [deltaView, blockView, turnView]) {
        const resets = transcriptEnvelopes(view.envelopes);
        expect(resets).toHaveLength(1);
        expect(resets[0]).toMatchObject({
          type: 'transcript.reset',
          volatile: true,
          session_id: 's1',
          payload: { agent_id: 'main', has_more_older: false, snapshot: { items: [] } },
        });
        expect(view.deliveries).toEqual(['subscription']);
      }
      expect(transcriptEnvelopes(plainView.envelopes)).toHaveLength(0);

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

      const turnBatchesBefore = transcriptEnvelopes(turnView.envelopes).length;
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' }));
      const deltaOps = transcriptEnvelopes(deltaView.envelopes).at(-1)!.payload as OpsPayload;
      expect(deltaOps.ops.map((o) => o.op)).toEqual(['frame.upsert', 'append']);
      const blockOps = transcriptEnvelopes(blockView.envelopes).at(-1)!.payload as OpsPayload;
      expect(blockOps.ops.map((o) => o.op)).toEqual(['frame.upsert']);
      expect(transcriptEnvelopes(turnView.envelopes)).toHaveLength(turnBatchesBefore);

      main.bus.emit(agentEvent('turn.step.completed', { turnId: 1, step: 1 }));
      const flushed = transcriptEnvelopes(blockView.envelopes).at(-1)!.payload as OpsPayload;
      expect(flushed.ops).toEqual([
        expect.objectContaining({
          op: 'frame.upsert',
          frame: expect.objectContaining({ kind: 'text', text: 'Hi' }),
        }),
        expect.objectContaining({ op: 'step.upsert' }),
      ]);
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

      await bc.subscribe('s1', view.target, undefined, { '*': 'turn' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.subscribe('s1', view.target, undefined, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

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
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      const late = lc.addAgent('agent-0');
      const resets = transcriptEnvelopes(view.envelopes);
      expect(resets).toHaveLength(2);
      expect(resets.at(-1)).toMatchObject({
        type: 'transcript.reset',
        payload: { agent_id: 'agent-0' },
      });
      expect(transcriptEnvelopes(offView.envelopes)).toHaveLength(0);

      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const ops = transcriptEnvelopes(view.envelopes).at(-1)!;
      expect(ops.type).toBe('transcript.ops');
      expect((ops.payload as OpsPayload).agent_id).toBe('agent-0');
    });

    it('streams for a client subscribed before any agent exists', async () => {
      const lc = new FakeLifecycle();
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

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
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.subscribe('s1', view.target, undefined, { main: 'delta' }, { deferTranscriptReset: true });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.flushTranscriptSeed('s1', view.target);
      const resets = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.reset');
      expect(resets).toHaveLength(2);
    });

    it('backfills wildcard-admitted roster agents before seeding their baseline', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
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

      const first = collectingTarget();
      await bc.subscribe('s1', first.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      const second = collectingTarget();
      const pending = bc.subscribe('s1', second.target, undefined, { '*': 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      await pending;
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

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, new Set(['main']), { '*': 'delta' });
      const resets = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.reset');
      expect(resets.map((e) => (e.payload as { agent_id: string }).agent_id)).toEqual([
        'main',
        'sub-1',
      ]);

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

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, new Set(['main']), { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(3);

      const sub = lc.addAgent('sub-1');
      sub.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const frames = transcriptEnvelopes(view.envelopes);
      expect(frames).toHaveLength(6);
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

      const full = collectingTarget();
      await bc.subscribe('s1', full.target, undefined, { main: 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'secret body' }));
      main.bus.emit(agentEvent('turn.step.completed', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

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

      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.ops');

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
      expect(seqs.every((seq) => seq !== undefined && seq > watermark!)).toBe(true);
      expect([...seqs].toSorted((a, b) => a! - b!)).toEqual(seqs);
      expect(ops.every((e) => e.volatile === true && e.seq === reset.seq)).toBe(true);
    });

    it('replays journaled batches instead of a reset when transcript_since is covered', async () => {
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

      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'hi' }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

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
      await bc.subscribe('s1', legacy.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' }));
      main.bus.emit(agentEvent('tool.result', { turnId: 1, toolCallId: 'tc-1', output: 'ok' }));
      await bc.getCursor('s1');

      expect(transcriptEnvelopes(graded.envelopes).length).toBeGreaterThan(0);
      const gradedTypes = graded.envelopes.map((e) => e.type);
      expect(gradedTypes).not.toContain('turn.started');
      expect(gradedTypes).not.toContain('turn.step.started');
      expect(gradedTypes).not.toContain('assistant.delta');
      expect(gradedTypes).not.toContain('tool.result');
      expect(gradedTypes).not.toContain('agent.status.updated');

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

      const late = lc.addAgent('agent-0');
      await bc.getCursor('s1');
      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');

      const types = view.envelopes.map((e) => e.type);
      expect(types).toContain('agent.created');
      expect(types).toContain('event.session.work_changed');
      expect(types).not.toContain('turn.started');
    });

    it('suppresses per agent — agents outside the spec keep their session_events', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

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
      await bc.getCursor('s1');
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await bc.getCursor('s1');

      const unfiltered = await bc.getBufferedSince('s1', { seq: 1 });
      expect(unfiltered.events.map((e) => e.envelope.type)).toEqual([
        'event.session.work_changed',
        'turn.ended',
        'event.session.work_changed',
      ]);

      const filtered = await bc.getBufferedSince('s1', { seq: 1 }, undefined, { '*': 'delta' });
      expect(filtered.events.map((e) => e.envelope.type)).toEqual([
        'event.session.work_changed',
        'event.session.work_changed',
      ]);

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
      expect(view.envelopes.map((e) => e.type)).not.toContain('turn.started');
      const opsBefore = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.ops');
      expect(new Set(opsBefore.map((e) => (e.payload as OpsPayload).agent_id))).toEqual(
        new Set(['main', 'agent-0']),
      );

      bc.unsubscribeTranscript('s1', view.target, ['main']);

      main.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      await bc.getCursor('s1');

      const turns = view.envelopes.filter((e) => e.type === 'turn.started');
      expect(turns.map((e) => (e.payload as { agentId: string }).agentId)).toEqual(['main']);
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
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      bc.unsubscribeTranscript('s1', view.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      await bc.getCursor('s1');
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);
      expect(view.envelopes.map((e) => e.type)).toContain('turn.started');

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
