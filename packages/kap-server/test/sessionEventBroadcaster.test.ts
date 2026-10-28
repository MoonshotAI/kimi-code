import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentContext,
  IScopeHandle,
  Scope,
  SessionActivityCause,
  SessionActivityChangedEvent,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  INTERACTION_TAG_SESSION_ID,
  LifecycleScope,
  IAgentLifecycleService,
  IAgentConversationUndoParticipantRegistry,
  IAgentLoopService,
  IAgentProfileService,
  IAgentScopeContext,
  IEventBus,
  IEventService,
  IModelCatalog,
  IModelService,
  ISessionActivityView,
  ISessionMetadata,
  ISessionLifecycleService,
  ISessionManager,
  ISessionTokenCountingService,
  ISessionUsageService,
  IWorkspaceInstanceManager,
  IWorkspaceSessions,
  MAIN_AGENT_ID,
  interactions,
  makeAgentScopeContext,
} from '@moonshot-ai/agent-core-v2';
import { Event2 } from '@moonshot-ai/agent-core-v2/app/event/event2';
import {
  AgentEventBusView,
  EventBusService,
} from '@moonshot-ai/agent-core-v2/app/event/eventBusService';
import type { AgentActivitySnapshot } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  interactionEventMessageSchema,
  type InteractionEventMessage,
} from '../src/protocol/interaction';
import { sessionEventMessageSchema } from '../src/protocol/ws-control';
import {
  type BroadcastDelivery,
  type BroadcastTarget,
  type EventEnvelope,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import { TranscriptService } from '../src/services/transcript/transcriptService';

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

class FakeManagerEvents {
  private readonly willDeleteHandlers = new Set<
    (event: {
      sessionId: string;
      signal: AbortSignal;
      waitUntil(cleanup: Promise<unknown>): void;
    }) => void
  >();
  private readonly didCreateHandlers = new Set<
    (event: { sessionId: string; handle: IScopeHandle }) => void
  >();
  private readonly didCloseHandlers = new Set<(event: { sessionId: string }) => void>();
  private readonly didArchiveHandlers = new Set<(event: { sessionId: string }) => void>();

  readonly onWillDeleteSession = (
    handler: (event: {
      sessionId: string;
      signal: AbortSignal;
      waitUntil(cleanup: Promise<unknown>): void;
    }) => void,
  ) => {
    this.willDeleteHandlers.add(handler);
    return { dispose: () => this.willDeleteHandlers.delete(handler) };
  };

  readonly onDidCreateSession = (
    handler: (event: { sessionId: string; handle: IScopeHandle }) => void,
  ) => {
    this.didCreateHandlers.add(handler);
    return { dispose: () => this.didCreateHandlers.delete(handler) };
  };

  readonly onDidCloseSession = (handler: (event: { sessionId: string }) => void) => {
    this.didCloseHandlers.add(handler);
    return { dispose: () => this.didCloseHandlers.delete(handler) };
  };

  readonly onDidArchiveSession = (handler: (event: { sessionId: string }) => void) => {
    this.didArchiveHandlers.add(handler);
    return { dispose: () => this.didArchiveHandlers.delete(handler) };
  };

  fireDidCreate(sessionId: string, handle: IScopeHandle): void {
    for (const handler of [...this.didCreateHandlers]) handler({ sessionId, handle });
  }

  fireDidClose(sessionId: string): void {
    for (const handler of [...this.didCloseHandlers]) handler({ sessionId });
  }

  fireDidArchive(sessionId: string): void {
    for (const handler of [...this.didArchiveHandlers]) handler({ sessionId });
  }

}

class FakeAgentHandle {
  readonly kind = LifecycleScope.Agent;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  readonly context: AgentContext;
  activity: AgentActivitySnapshot = {};
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
    this.services.set(IAgentConversationUndoParticipantRegistry, {
      register: () => ({ dispose: () => {} }),
    });
    this.services.set(IAgentLoopService, {
      snapshot: () => ({
        state: this.activity.turn === undefined ? 'idle' : 'running',
        turn: this.activity.turn,
      }),
    });
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
  readonly workView: FakeSessionActivityView;

  constructor(readonly sessionId = 's1') {
    this.workView = new FakeSessionActivityView(this);
  }

  private readonly turnCounters = new Map<string, { dispose(): void }>();
  private createHandlers: Array<(context: AgentContext) => void> = [];
  private disposeHandlers: Array<(context: AgentContext) => void> = [];
  list(): readonly AgentContext[] {
    return this.handles.map((handle) => handle.context);
  }
  get(context: AgentContext): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === context.agentId);
  }
  getHandle(id: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === id);
  }
  handleOf(agentId: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === agentId);
  }
  onDidCreate(h: (context: AgentContext) => void) {
    this.createHandlers.push(h);
    return { dispose: () => {} };
  }
  onDidClose(h: (context: AgentContext) => void) {
    this.disposeHandlers.push(h);
    return { dispose: () => {} };
  }
  addAgent(id: string): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    const onTurnStarted = handle.bus.subscribe((e) => {
      if (e.type !== 'turn.started') return;
      handle.activity = {
        turn: {
          turnId: (e as { turnId?: number }).turnId ?? 0,
          phase: 'running',
          step: 1,
          ending: false,
          activeToolCalls: [],
          since: 0,
        },
      };
    });
    const onTurnEnded = handle.bus.subscribe((e) => {
      if (e.type !== 'turn.ended') return;
      handle.activity = {};
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
}

function mapReason(reason: string | undefined): 'completed' | 'cancelled' | 'failed' | undefined {
  if (reason === undefined) return undefined;
  return reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
}

class FakeSessionActivityView {
  private readonly listeners = new Set<(change: SessionActivityChangedEvent) => void>();
  private readonly folds = new Map<
    string,
    { turnActive: boolean; background: number; lastTurnReason?: 'completed' | 'cancelled' | 'failed' }
  >();
  private readonly busSubscriptions = new Map<string, { dispose(): void }>();
  private readonly lifecycle: FakeLifecycle;
  private current: SessionActivityState;

  constructor(lifecycle: FakeLifecycle) {
    this.lifecycle = lifecycle;
    for (const handle of lifecycle.list()) this.attach(handle as unknown as FakeAgentHandle);
    lifecycle.onDidCreate((context) => {
      const handle = lifecycle.get(context);
      if (handle !== undefined) this.attach(handle as unknown as FakeAgentHandle);
      this.recompute('agent_lifecycle');
    });
    lifecycle.onDidClose((context) => {
      const agentId = context.agentId;
      this.busSubscriptions.get(agentId)?.dispose();
      this.busSubscriptions.delete(agentId);
      if (this.folds.delete(agentId)) this.recompute('agent_lifecycle');
    });
    interactions.onDidChangePending(() => this.recompute('interaction'));
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
    this.folds.set(handle.id, {
      turnActive: handle.activity.turn !== undefined,
      background: 0,
    });
    const subscriptions = [
      handle.bus.subscribe('turn.started', () =>
        this.patchFold(handle.id, (f) => ({
          ...f,
          turnActive: true,
          lastTurnReason: handle.id === MAIN_AGENT_ID ? undefined : f.lastTurnReason,
        })),
      ),
      handle.bus.subscribe('turn.ended', (e) =>
        this.patchFold(handle.id, (f) => ({
          ...f,
          turnActive: false,
          lastTurnReason:
            handle.id === MAIN_AGENT_ID
              ? mapReason((e as { reason?: string }).reason)
              : f.lastTurnReason,
        })),
      ),
      handle.bus.subscribe('task.started', () =>
        this.patchFold(handle.id, (f) => ({ ...f, background: f.background + 1 })),
      ),
      handle.bus.subscribe('task.terminated', () =>
        this.patchFold(handle.id, (f) => ({ ...f, background: f.background - 1 })),
      ),
      handle.bus.subscribe('compaction.started', () =>
        this.patchFold(handle.id, (f) => ({ ...f, background: f.background + 1 })),
      ),
      handle.bus.subscribe('compaction.completed', () =>
        this.patchFold(handle.id, (f) => ({ ...f, background: f.background - 1 })),
      ),
      handle.bus.subscribe('compaction.cancelled', () =>
        this.patchFold(handle.id, (f) => ({ ...f, background: f.background - 1 })),
      ),
    ];
    this.busSubscriptions.set(handle.id, {
      dispose: () => subscriptions.forEach((s) => s.dispose()),
    });
  }

  private patchFold(
    agentId: string,
    patch: (fold: {
      turnActive: boolean;
      background: number;
      lastTurnReason?: 'completed' | 'cancelled' | 'failed';
    }) => {
      turnActive: boolean;
      background: number;
      lastTurnReason?: 'completed' | 'cancelled' | 'failed';
    },
  ): void {
    const previous = this.folds.get(agentId);
    if (previous === undefined) return;
    const next = patch(previous);
    this.folds.set(agentId, next);
    let cause: SessionActivityCause | undefined;
    if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background !== next.background) cause = 'background';
    else if (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason) {
      cause = 'turn_ended';
    }
    if (cause !== undefined) this.recompute(cause);
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
    const pending = interactions.findAll({
      resolved: false,
      tags: { [INTERACTION_TAG_SESSION_ID]: this.lifecycle.sessionId },
    });
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
  managerEvents?: FakeManagerEvents,
): Scope {
  const handles = new WeakMap<FakeLifecycle, IScopeHandle>();
  const sessionFor = (sid: string) => {
    const lifecycle = sessions.get(sid);
    if (lifecycle === undefined) return undefined;
    const existing = handles.get(lifecycle);
    if (existing !== undefined) return existing;
    const sessionAccessor = {
      get: (t: unknown) => {
        if (t === IAgentLifecycleService) return lifecycle;
        if (t === ISessionActivityView) return lifecycle.workView;
        if (t === ISessionMetadata) return { read: async () => ({ agents: metaAgents }) };
        return undefined;
      },
    };
    const handle = { id: sid, kind: LifecycleScope.Session, accessor: sessionAccessor, dispose: () => {} } as unknown as IScopeHandle;
    handles.set(lifecycle, handle);
    return handle;
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
          resume: async (sessionId: string) => sessionFor(sessionId),
          list: () => [...sessions.keys()].map((sessionId) => sessionFor(sessionId)),
          onWillDeleteSession: managerEvents?.onWillDeleteSession,
          onDidCreateSession: managerEvents?.onDidCreateSession,
          onDidCloseSession: managerEvents?.onDidCloseSession,
          onDidArchiveSession: managerEvents?.onDidArchiveSession,
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

function agentEvent(type: string, extra: Record<string, unknown> = {}): FakeBusEvent {
  return { type, ...extra };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionHandle(core: Scope, sessionId: string): IScopeHandle {
  return core.accessor.get(ISessionManager).get(sessionId) as IScopeHandle;
}

function workChanges(envelopes: readonly EventEnvelope[]): EventEnvelope[] {
  return envelopes.filter((e) => e.type === 'event.session.work_changed');
}

function collectingTarget(): {
  target: BroadcastTarget;
  envelopes: EventEnvelope[];
  interactionMessages: InteractionEventMessage[];
  deliveries: BroadcastDelivery[];
} {
  const envelopes: EventEnvelope[] = [];
  const interactionMessages: InteractionEventMessage[] = [];
  const deliveries: BroadcastDelivery[] = [];
  return {
    target: {
      send: (frame, delivery = 'subscription') => {
        if (frame.type === 'interaction' && !('payload' in frame)) {
          interactionMessages.push(frame);
        } else {
          envelopes.push(frame as EventEnvelope);
        }
        deliveries.push(delivery);
      },
    },
    envelopes,
    interactionMessages,
    deliveries,
  };
}

describe('SessionEventBroadcaster', () => {
  let dir: string;
  let sessions: Map<string, FakeLifecycle>;
  let eventBus: FakeEventBus;
  let managerEvents: FakeManagerEvents;
  let core: Scope;
  let bc: SessionEventBroadcaster;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    sessions = new Map();
    eventBus = new FakeEventBus();
    managerEvents = new FakeManagerEvents();
    core = makeCore(sessions, eventBus, {}, managerEvents);
    bc = new SessionEventBroadcaster({ core });
  });

  afterEach(async () => {
    await bc.close();
    for (const sessionId of sessions.keys()) interactions.purgeSession(sessionId);
    await rm(dir, { recursive: true, force: true });
  });

  function openSession(sessionId = 's1'): FakeLifecycle {
    const lifecycle = new FakeLifecycle(sessionId);
    sessions.set(sessionId, lifecycle);
    managerEvents.fireDidCreate(sessionId, sessionHandle(core, sessionId));
    return lifecycle;
  }

  it('subscribe returns false for an unknown session', async () => {
    const { target } = collectingTarget();
    expect(await bc.subscribe('nope', target, { '*': 'turn' })).toBe(false);
  });

  it('broadcasts session.meta.updated under the real session id and fans out to every connection', async () => {

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    bc.addGlobalTarget(s1View.target);
    bc.addGlobalTarget(s2View.target);

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
  });

  it('broadcasts event.session.created under the real session id and fans out to every connection', async () => {

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    bc.addGlobalTarget(s1View.target);
    bc.addGlobalTarget(s2View.target);

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

  it('fans out event.session.deleted to every connection, including for cold sessions', async () => {
    const globalView = collectingTarget();
    bc.addGlobalTarget(globalView.target);

    eventBus.emit({
      type: 'event.session.deleted',
      payload: { sessionId: 'cold-1', workspaceId: 'wd_cold' },
    });

    await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
    expect(globalView.envelopes[0]).toMatchObject({
      type: 'event.session.deleted',
      session_id: '__global__',
      payload: {
        type: 'event.session.deleted',
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

    it('stops delivering after removeGlobalTarget', async () => {
      sessions.set('s1', new FakeLifecycle());

      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);
      bc.removeGlobalTarget(globalView.target);

      eventBus.emit({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: 's1', session: { id: 's1' } },
      });
      await settle();

      expect(globalView.envelopes).toHaveLength(0);
    });

    it('delivers exactly one copy to a target that is both global and subscribed', async () => {
      sessions.set('s1', new FakeLifecycle());

      const both = collectingTarget();
      bc.addGlobalTarget(both.target);
      await bc.subscribe('s1', both.target, { '*': 'turn' });

      eventBus.emit({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: 's1', session: { id: 's1' } },
      });

      await vi.waitFor(() => expect(both.envelopes).toHaveLength(1));
      await settle();
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

    it('delivers event.config.changed to a global-only target that never subscribed', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const config = { default_model: 'k2', providers: {} };
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['defaultModel'], config },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.config.changed',
        session_id: '__global__',
        payload: { changedFields: ['defaultModel'], config },
      });
      expect(globalView.deliveries).toEqual(['immediate']);
    });

    it('preserves unlisted config domains through event validation', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const config = { default_model: 'k2', providers: {}, mcp: { servers: { fs: { command: 'npx' } } } };
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['mcp'], config },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.config.changed',
        session_id: '__global__',
        payload: { changedFields: ['mcp'], config },
      });
    });

    it('drops malformed event.config.changed payloads', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      eventBus.emit({ type: 'event.config.changed', payload: null });
      eventBus.emit({ type: 'event.config.changed', payload: { changedFields: 'defaultModel' } });
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['defaultModel', 7], config: {} },
      });
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['defaultModel'], config: null },
      });
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['defaultModel'], config: [] },
      });
      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: [''], config: {} },
      });

      eventBus.emit({
        type: 'event.config.changed',
        payload: { changedFields: ['models'], config: { models: {} } },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.config.changed',
        payload: { changedFields: ['models'], config: { models: {} } },
      });
    });

    it('delivers event.model_catalog.changed to a global-only target that never subscribed', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const changed = [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 1 },
      ];
      const failed = [{ provider: 'managed:kimi-code', reason: 'network disabled' }];
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed, unchanged: ['openai-main'], failed },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.model_catalog.changed',
        session_id: '__global__',
        payload: { changed, unchanged: ['openai-main'], failed },
      });
      expect(globalView.deliveries).toEqual(['immediate']);
    });

    it('forwards retired_default on event.model_catalog.changed', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      const changed = [{ provider_id: 'acme', provider_name: 'Acme', added: 0, removed: 1 }];
      const retiredDefault = {
        from: 'acme/current',
        to: 'acme/next',
        from_display_name: 'Current',
      };
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed, unchanged: [], failed: [], retired_default: retiredDefault },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.model_catalog.changed',
        session_id: '__global__',
        payload: { changed, unchanged: [], failed: [], retired_default: retiredDefault },
      });
      expect(globalView.deliveries).toEqual(['immediate']);
    });

    it('drops malformed event.model_catalog.changed payloads', async () => {
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      eventBus.emit({ type: 'event.model_catalog.changed', payload: null });
      eventBus.emit({ type: 'event.model_catalog.changed', payload: { changed: [] } });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: {
          changed: [{ provider_id: 'p', provider_name: 'P', added: '1', removed: 0 }],
          unchanged: [],
          failed: [],
        },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: {
          changed: [{ provider_id: 'p', provider_name: 'P', added: -1, removed: 0 }],
          unchanged: [],
          failed: [],
        },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: {
          changed: [{ provider_id: 'p', provider_name: 'P', added: 0.5, removed: 0 }],
          unchanged: [],
          failed: [],
        },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: {
          changed: [{ provider_id: '', provider_name: 'P', added: 1, removed: 0 }],
          unchanged: [],
          failed: [],
        },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: ['ok', 7], failed: [] },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: ['ok', ''], failed: [] },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: [], failed: [{ provider: 'p' }] },
      });
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: [], failed: [{ provider: 'p', reason: '' }] },
      });

      const changed = [
        { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
      ];
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed, unchanged: [], failed: [] },
      });

      await vi.waitFor(() => expect(globalView.envelopes).toHaveLength(1));
      expect(globalView.envelopes[0]).toMatchObject({
        type: 'event.model_catalog.changed',
        payload: { changed, unchanged: [], failed: [] },
      });
    });
  });

  describe('App-level work_changed', () => {
    it('delivers work_changed for a live session nobody subscribed to', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await settle();

      expect(globalView.envelopes.map((e) => e.type)).toEqual([
        'event.session.work_changed',
        'event.session.work_changed',
      ]);
      expect(globalView.envelopes[0]).toMatchObject({
        session_id: 's1',
        payload: {
          type: 'event.session.work_changed',
          busy: true,
          main_turn_active: true,
          last_turn_reason: undefined,
          agentId: 'main',
          sessionId: 's1',
        },
      });
      expect(globalView.envelopes[1]).toMatchObject({
        session_id: 's1',
        payload: { busy: false, main_turn_active: false, last_turn_reason: 'completed' },
      });
      expect(globalView.deliveries).toEqual(['immediate', 'immediate']);
    });

    it('fans work_changed out to every connection, whichever session they subscribed to', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      openSession('s2');
      const s1View = collectingTarget();
      const s2View = collectingTarget();
      bc.addGlobalTarget(s1View.target);
      bc.addGlobalTarget(s2View.target);
      await bc.subscribe('s2', s2View.target, { '*': 'turn' });

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();

      for (const view of [s1View, s2View]) {
        expect(workChanges(view.envelopes)).toHaveLength(1);
        expect(workChanges(view.envelopes)[0]).toMatchObject({ session_id: 's1' });
      }
    });

    it('tracks sessions that were already live when the broadcaster started', async () => {
      const lc = new FakeLifecycle('s1');
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      await bc.close();
      bc = new SessionEventBroadcaster({ core });
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();

      expect(workChanges(globalView.envelopes)).toHaveLength(1);
    });

    it('stops tracking a closed session and resumes once it is created again', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      managerEvents.fireDidClose('s1');
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();
      expect(workChanges(globalView.envelopes)).toHaveLength(0);

      managerEvents.fireDidCreate('s1', sessionHandle(core, 's1'));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await settle();
      expect(workChanges(globalView.envelopes)).toHaveLength(1);
      expect(workChanges(globalView.envelopes)[0]!.payload).toMatchObject({ busy: false });
    });

    it('stops tracking an archived session', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      managerEvents.fireDidArchive('s1');
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();

      expect(workChanges(globalView.envelopes)).toHaveLength(0);
    });

    it('maps the main turn outcome into last_turn_reason on the post-turn work_changed', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      for (const [turnId, reason] of [
        [1, 'cancelled'],
        [2, 'failed'],
        [3, 'blocked'],
      ] as const) {
        main.bus.emit(agentEvent('turn.started', { turnId }));
        await settle();
        main.bus.emit(agentEvent('turn.ended', { turnId, reason }));
        await settle();
      }

      expect(workChanges(globalView.envelopes).map((e) => e.payload)).toMatchObject([
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: 'cancelled' },
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: 'failed' },
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: 'failed' },
      ]);
    });

    it('flips busy from background tasks alone (no turn involved)', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      main.bus.emit(agentEvent('task.started', { agentId: 'main' }));
      await settle();
      main.bus.emit(agentEvent('task.terminated', { agentId: 'main' }));
      await settle();

      expect(workChanges(globalView.envelopes).map((e) => e.payload)).toMatchObject([
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: undefined },
      ]);
    });

    it('reports the main turn ending while sub-agent background work keeps busy true', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      sub.bus.emit(agentEvent('task.started', { agentId: 'agent-0' }));
      await settle();
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await settle();

      expect(workChanges(globalView.envelopes).map((e) => e.payload)).toMatchObject([
        { busy: true, main_turn_active: false },
        { busy: true, main_turn_active: true },
        { busy: true, main_turn_active: false, last_turn_reason: 'completed' },
      ]);
    });

    it('flips busy but never touches last_turn_reason from sub-agent turn boundaries', async () => {
      const lc = openSession('s1');
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      const globalView = collectingTarget();
      bc.addGlobalTarget(globalView.target);

      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await settle();
      sub.bus.emit(agentEvent('turn.started', { turnId: 10 }));
      await settle();
      sub.bus.emit(agentEvent('turn.ended', { turnId: 10, reason: 'completed' }));
      await settle();
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
      await settle();
      sub.bus.emit(agentEvent('turn.started', { turnId: 11 }));
      await settle();
      sub.bus.emit(agentEvent('turn.ended', { turnId: 11, reason: 'cancelled' }));
      await settle();

      expect(workChanges(globalView.envelopes).map((e) => e.payload)).toMatchObject([
        { busy: true, last_turn_reason: undefined },
        { busy: false, last_turn_reason: 'completed' },
        { busy: true, last_turn_reason: 'completed' },
        { busy: false, last_turn_reason: 'completed' },
      ]);
    });
  });

  it('broadcasts a question as interaction frames from pending to answered', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, interactionMessages } = collectingTarget();
    await bc.subscribe('s1', target, { '*': 'turn' });

    interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: {
        toolCallId: 'call_1',
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      tags: { sessionId: 's1' },
    });
    interactions.respond('q1', { answers: { q_0: 'opt_0_0' }, method: 'enter' });

    for (const message of interactionMessages) {
      expect(interactionEventMessageSchema.parse(message)).toEqual(
        JSON.parse(JSON.stringify(message)),
      );
    }
    expect(interactionMessages).toMatchObject([
      {
        type: 'interaction',
        session_id: 's1',
        agent_id: 'main',
        interaction_id: 'q1',
        kind: 'question',
        status: 'pending',
        tool_call_id: 'call_1',
        request: {
          questions: [
            {
              id: 'q_0',
              question: 'Pick one',
              options: [
                { id: 'opt_0_0', label: 'A' },
                { id: 'opt_0_1', label: 'B' },
              ],
            },
          ],
        },
      },
      {
        interaction_id: 'q1',
        status: 'ended',
        outcome: 'answered',
        response: { answers: { q_0: 'opt_0_0' }, method: 'enter' },
      },
    ]);
    expect(interactionMessages[0]!.event_created_at).toBeTypeOf('string');
    expect(interactionMessages[1]!.ended_at).toBe(interactionMessages[1]!.event_created_at);
  });

  it('ends dismissed and cancelled questions without a response', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, interactionMessages } = collectingTarget();
    await bc.subscribe('s1', target, { '*': 'turn' });

    const question = { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] };
    interactions.enqueue({ id: 'q1', kind: 'question', payload: question, tags: { sessionId: 's1' } });
    interactions.respond('q1', null);
    interactions.enqueue({ id: 'q2', kind: 'question', payload: question, tags: { sessionId: 's1' } });
    interactions.respond('q2', { cancelled: true, reason: 'turn_ended' });

    const ended = interactionMessages.filter((m) => m.status === 'ended');
    expect(ended).toMatchObject([
      { interaction_id: 'q1', outcome: 'dismissed' },
      { interaction_id: 'q2', outcome: 'cancelled' },
    ]);
    expect(ended.map((m) => m.response)).toEqual([undefined, undefined]);
  });

  it('carries the approval decision, including cancellation, on ended approvals', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, interactionMessages } = collectingTarget();
    await bc.subscribe('s1', target, { '*': 'turn' });

    const request = {
      toolCallId: 'call_9',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'ls' },
    };
    interactions.enqueue({ id: 'a1', kind: 'approval', payload: request, tags: { sessionId: 's1' } });
    interactions.respond('a1', { decision: 'approved', scope: 'session' });
    interactions.enqueue({ id: 'a2', kind: 'approval', payload: request, tags: { sessionId: 's1' } });
    interactions.respond('a2', { cancelled: true, reason: 'agent_closed' });

    expect(interactionMessages).toMatchObject([
      {
        interaction_id: 'a1',
        kind: 'approval',
        status: 'pending',
        tool_call_id: 'call_9',
        request: {
          tool_name: 'Bash',
          action: 'run',
          tool_input_display: { kind: 'command', command: 'ls' },
          expires_at: expect.any(String),
        },
      },
      {
        interaction_id: 'a1',
        status: 'ended',
        outcome: 'approved',
        response: { decision: 'approved', scope: 'session' },
      },
      { interaction_id: 'a2', status: 'pending' },
      {
        interaction_id: 'a2',
        status: 'ended',
        outcome: 'cancelled',
        response: { decision: 'cancelled' },
      },
    ]);
  });

  it('delivers sub-agent interactions to a session subscriber whatever its transcript grades', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, interactionMessages } = collectingTarget();
    await bc.subscribe('s1', target, { main: 'turn', 'agent-0': 'off' });

    interactions.enqueue({
      id: 'a-sub',
      kind: 'approval',
      payload: { toolCallId: 'call_sub', toolName: 'Bash', action: 'run' },
      tags: { agentId: 'agent-0', sessionId: 's1' },
    });
    interactions.respond('a-sub', { decision: 'rejected' });

    expect(interactionMessages).toMatchObject([
      { agent_id: 'agent-0', interaction_id: 'a-sub', status: 'pending' },
      { agent_id: 'agent-0', interaction_id: 'a-sub', status: 'ended', outcome: 'rejected' },
    ]);
  });

  it('sends pending interactions only to the requesting target and immediately', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    interactions.enqueue({
      id: 'q0',
      kind: 'question',
      payload: { questions: [{ question: 'Early', options: [{ label: 'A' }] }] },
      tags: { sessionId: 's1' },
    });

    const asking = collectingTarget();
    const other = collectingTarget();
    await bc.subscribe('s1', asking.target, { '*': 'turn' });
    await bc.subscribe('s1', other.target, { '*': 'turn' });
    expect(asking.interactionMessages).toHaveLength(0);

    bc.sendPendingInteractions('s1', asking.target);
    expect(asking.interactionMessages).toMatchObject([
      { interaction_id: 'q0', status: 'pending' },
    ]);
    expect(asking.deliveries.at(-1)).toBe('immediate');
    expect(other.interactionMessages).toHaveLength(0);

    interactions.respond('q0', { answers: { q_0: 'opt_0_0' } });
    for (const view of [asking, other]) {
      expect(view.interactionMessages.at(-1)).toMatchObject({
        interaction_id: 'q0',
        status: 'ended',
      });
    }

    const before = asking.interactionMessages.length;
    bc.sendPendingInteractions('s1', asking.target);
    expect(asking.interactionMessages).toHaveLength(before);
  });

  it('stops sending interactions once the subscriber unsubscribes', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, interactionMessages } = collectingTarget();
    await bc.subscribe('s1', target, { '*': 'turn' });
    bc.unsubscribe('s1', target);

    interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
      tags: { sessionId: 's1' },
    });

    expect(interactionMessages).toHaveLength(0);
  });

  describe('transcript streaming', () => {
    function makeBroadcasterWithTranscript(
      metaAgents?: Record<string, { type?: string; parentAgentId?: string }>,
    ): SessionEventBroadcaster {
      const core = makeCore(sessions, eventBus, metaAgents);
      return new SessionEventBroadcaster({
        core,
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
      await bc.subscribe('s1', deltaView.target, { '*': 'delta' });
      await bc.subscribe('s1', blockView.target, { '*': 'block' });
      await bc.subscribe('s1', turnView.target, { '*': 'turn' });

      for (const view of [deltaView, blockView, turnView]) {
        const resets = transcriptEnvelopes(view.envelopes);
        expect(resets).toHaveLength(1);
        expect(resets[0]).toMatchObject({
          type: 'transcript.reset',
          session_id: 's1',
          payload: { agent_id: 'main', has_more_older: false, snapshot: { items: [] } },
        });
        expect(view.deliveries).toEqual(['subscription']);
      }

      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      for (const view of [deltaView, blockView, turnView]) {
        const batches = transcriptEnvelopes(view.envelopes).slice(-1);
        for (const ops of batches) expect(ops.type).toBe('transcript.ops');
        expect(batches.map((ops) => (ops.payload as OpsPayload).ops.map((o) => o.op))).toEqual([
          ['turn.upsert', 'meta.merge', 'meta.merge'],
        ]);
      }

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
    });

    it('re-sends transcript.reset on grade upgrade, not on equal or downgraded re-subscribe', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'turn' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.subscribe('s1', view.target, { '*': 'turn' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.subscribe('s1', view.target, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);

      await bc.subscribe('s1', view.target, { '*': 'delta' });
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
      await bc.subscribe('s1', view.target, { '*': 'delta' });
      await bc.subscribe('s1', offView.target, { '*': 'off' });
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
      await bc.subscribe('s1', view.target, { '*': 'delta' });

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
      await bc.subscribe('s1', view.target, { main: 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const before = transcriptEnvelopes(view.envelopes).length;

      const resub = bc.subscribe('s1', view.target, { main: 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      await resub;

      const after = transcriptEnvelopes(view.envelopes);
      expect(after.length).toBeGreaterThan(before);
      expect(after.some((e) => e.type === 'transcript.ops')).toBe(true);
    });

    it('backfills wildcard-admitted roster agents before seeding their baseline', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript({ 'sub-1': { type: 'sub' } });

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'delta' });
      const ids = transcriptEnvelopes(view.envelopes)
        .filter((e) => e.type === 'transcript.reset')
        .map((e) => (e.payload as { agent_id: string }).agent_id)
        .toSorted();
      expect(ids).toEqual(['main', 'sub-1']);
    });

    it('sends no resets when the target downgrades while the seed is in flight', async () => {
      const lc = new FakeLifecycle();
      lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'off' });
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(0);

      const pending = bc.subscribe('s1', view.target, { '*': 'delta' });
      await bc.subscribe('s1', view.target, { '*': 'off' });
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
      bc = new SessionEventBroadcaster({ core, transcriptService: service });

      const view = collectingTarget();
      const pending = bc.subscribe('s1', view.target, { 'sub-1': 'delta' });
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
      bc = new SessionEventBroadcaster({ core, transcriptService: service });

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const opsBefore = transcriptEnvelopes(view.envelopes).filter(
        (e) => e.type === 'transcript.ops',
      ).length;
      expect(opsBefore).toBeGreaterThan(0);

      service.dropSession('s1');
      await bc.subscribe('s1', view.target, { '*': 'delta' });
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
      await bc.subscribe('s1', first.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      const second = collectingTarget();
      const pending = bc.subscribe('s1', second.target, { '*': 'delta' });
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'x' }));
      await pending;
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'y' }));

      const types = transcriptEnvelopes(second.envelopes).map((e) => e.type);
      expect(types[0]).toBe('transcript.reset');
      expect(types.indexOf('transcript.ops')).toBeGreaterThan(types.indexOf('transcript.reset'));
    });

    it('sends an items-empty baseline reset marking older history, with global state and the watermark', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const full = collectingTarget();
      await bc.subscribe('s1', full.target, { main: 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      main.bus.emit(agentEvent('turn.step.started', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'secret body' }));
      main.bus.emit(agentEvent('turn.step.completed', { turnId: 1, step: 1 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

      const late = collectingTarget();
      await bc.subscribe('s1', late.target, { main: 'turn' });
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
      await bc.subscribe('s1', view.target, { '*': 'off', main: 'delta' });

      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(1);
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.ops');

      const late = lc.addAgent('agent-0');
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(2);
      late.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(2);
    });

    it('stamps ops payloads with the batch seq and resets with the watermark', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'delta' });
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
    });

    it('replays journaled batches instead of a reset when transcript_since is covered', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const first = collectingTarget();
      await bc.subscribe('s1', first.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const cursor = (
        transcriptEnvelopes(first.envelopes).at(-1)!.payload as { seq: number }
      ).seq;

      main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'hi' }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));

      const second = collectingTarget();
      await bc.subscribe('s1', second.target, { '*': 'delta' }, { main: cursor });
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
      await bc.subscribe('s1', first.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const cursor = (
        transcriptEnvelopes(first.envelopes).at(-1)!.payload as { seq: number }
      ).seq;

      const second = collectingTarget();
      await bc.subscribe('s1', second.target, { '*': 'delta' }, { main: cursor });
      expect(transcriptEnvelopes(second.envelopes)).toHaveLength(0);
    });

    it('falls back to a watermarked reset when transcript_since is not covered', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const first = collectingTarget();
      await bc.subscribe('s1', first.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));

      const second = collectingTarget();
      await bc.subscribe('s1', second.target, { '*': 'delta' }, { main: 9999 });
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

    it('narrows the stream per agent on a grade update and stops it on unsubscribe', async () => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      const sub = lc.addAgent('agent-0');
      sessions.set('s1', lc);
      bc = makeBroadcasterWithTranscript();

      const view = collectingTarget();
      await bc.subscribe('s1', view.target, { '*': 'delta' });
      main.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 1, origin: { kind: 'user' } }));
      const opsBefore = transcriptEnvelopes(view.envelopes).filter((e) => e.type === 'transcript.ops');
      expect(new Set(opsBefore.map((e) => (e.payload as OpsPayload).agent_id))).toEqual(
        new Set(['main', 'agent-0']),
      );

      bc.updateTranscriptGrades('s1', view.target, { '*': 'delta', main: 'off' });
      main.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 2, origin: { kind: 'user' } }));
      const opsAfter = transcriptEnvelopes(view.envelopes)
        .filter((e) => e.type === 'transcript.ops')
        .slice(opsBefore.length);
      expect(opsAfter.length).toBeGreaterThan(0);
      expect(new Set(opsAfter.map((e) => (e.payload as OpsPayload).agent_id))).toEqual(
        new Set(['agent-0']),
      );

      const total = transcriptEnvelopes(view.envelopes).length;
      bc.unsubscribe('s1', view.target);
      sub.bus.emit(agentEvent('turn.started', { turnId: 3, origin: { kind: 'user' } }));
      expect(transcriptEnvelopes(view.envelopes)).toHaveLength(total);

      await bc.subscribe('s1', view.target, { '*': 'delta' });
      expect(transcriptEnvelopes(view.envelopes).at(-1)!.type).toBe('transcript.reset');
    });

    it('ignores grade updates and unsubscribes for sessions it never activated', async () => {
      const view = collectingTarget();
      expect(() => bc.updateTranscriptGrades('nope', view.target, { '*': 'delta' })).not.toThrow();
      expect(() => bc.unsubscribe('nope', view.target)).not.toThrow();
    });
  });
});

describe('sessionEventMessageSchema', () => {
  const timestamp = '2026-08-27T00:00:00.000Z';

  function envelope(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      type: payload['type'],
      session_id: '__global__',
      timestamp,
      payload: { agentId: 'main', sessionId: '__global__', ...payload },
    };
  }

  it('accepts config changed, config warning, and model catalog changed envelopes', () => {
    expect(
      sessionEventMessageSchema.safeParse(
        envelope({
          type: 'event.config.changed',
          changedFields: ['defaultModel'],
          config: { default_model: 'k2', providers: {} },
        }),
      ).success,
    ).toBe(true);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({
          type: 'event.config.warning',
          warnings: [{ domain: 'loopControl', message: 'deprecated key' }, { message: 'other' }],
        }),
      ).success,
    ).toBe(true);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({
          type: 'event.model_catalog.changed',
          changed: [
            { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 1 },
          ],
          unchanged: ['openai-main'],
          failed: [{ provider: 'managed:kimi-code', reason: 'network disabled' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects raw agent events, which are no longer pushed', () => {
    expect(
      sessionEventMessageSchema.safeParse(envelope({ type: 'turn.started', turnId: 1 })).success,
    ).toBe(false);
  });

  it('rejects malformed config and model catalog event envelopes', () => {
    expect(
      sessionEventMessageSchema.safeParse(
        envelope({ type: 'event.config.changed', changedFields: 'defaultModel', config: {} }),
      ).success,
    ).toBe(false);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({ type: 'event.config.changed', changedFields: [], config: [] }),
      ).success,
    ).toBe(false);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({ type: 'event.config.warning', warnings: [{ domain: 'loopControl' }] }),
      ).success,
    ).toBe(false);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({
          type: 'event.model_catalog.changed',
          changed: [],
          failed: [],
        }),
      ).success,
    ).toBe(false);

    expect(
      sessionEventMessageSchema.safeParse(
        envelope({
          type: 'event.model_catalog.changed',
          changed: [],
          unchanged: [],
          failed: [{ provider: 'managed:kimi-code', reason: 42 }],
        }),
      ).success,
    ).toBe(false);
  });
});
