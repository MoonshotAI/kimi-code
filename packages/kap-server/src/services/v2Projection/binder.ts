import type {
  AgentContext,
  Scope,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentInteractionService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IEventBus,
  ISessionActivityView,
  getLiveSessionById,
  onSessionInteractionDidChangePending,
  onSessionInteractionDidResolve,
} from '@moonshot-ai/agent-core-v2';

import { serverMessageSchema, type ServerMessage } from '../../protocol/v2/messages/index';
import type { ProjectionEvent } from './agentProjector';
import { toWireInteractionRequest, toWireInteractionResponse } from './interactionWire';
import { SessionV2Projector } from './sessionProjector';
import type { ComposerTurnFact, SessionFactsPatch } from './sessionStateComposer';

export interface V2Disposable {
  dispose(): void;
}

export type V2BusEvent = ProjectionEvent & { type: string };

export interface V2AgentSource {
  readonly agentId: string;
  readonly bus: {
    subscribe(handler: (event: V2BusEvent) => void): V2Disposable;
  };
  permissionMode?(): 'manual' | 'yolo' | 'auto' | undefined;
}

export interface V2PendingInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly toolCallId?: string;
  readonly request: unknown;
}

export interface V2InteractionSource {
  listPending(agentId: string): readonly V2PendingInteraction[];
  onDidChangePending(handler: (agentId: string) => void): V2Disposable;
  onDidResolve(handler: (event: { agentId: string; id: string; response: unknown }) => void): V2Disposable;
}

export interface V2SessionSource {
  readonly sessionId: string;
  agents(): readonly V2AgentSource[];
  agentFor(agentId: string): V2AgentSource | undefined;
  onAgentCreated?(handler: (agentId: string) => void): V2Disposable;
  readonly activity?: {
    state(): SessionActivityState;
    onDidChange(handler: (state: SessionActivityState, time?: number) => void): V2Disposable;
  };
  readonly interactions?: V2InteractionSource;
}

interface StatusFactEvent {
  model?: string;
  thinkingEffort?: string;
  contextTokens?: number;
  maxContextTokens?: number;
  usage?: { byModel?: Record<string, unknown>; total?: unknown; currentTurn?: unknown };
}

function factsPatchForEvent(event: V2BusEvent): SessionFactsPatch | undefined {
  switch (event.type) {
    case 'agent.status.updated': {
      const status: StatusFactEvent = {};
      const model = event.model as string | undefined;
      const thinkingEffort = event.thinkingEffort as string | undefined;
      const contextTokens = event.contextTokens as number | undefined;
      const maxContextTokens = event.maxContextTokens as number | undefined;
      const usage = event.usage as StatusFactEvent['usage'];
      if (model !== undefined) status.model = model;
      if (thinkingEffort !== undefined) status.thinkingEffort = thinkingEffort;
      if (contextTokens !== undefined) status.contextTokens = contextTokens;
      if (maxContextTokens !== undefined) status.maxContextTokens = maxContextTokens;
      if (usage !== undefined) status.usage = usage;
      return Object.keys(status).length > 0 ? { status } : undefined;
    }
    case 'agent.activity.updated': {
      const lifecycle = event.lifecycle as 'ready' | 'disposed' | undefined;
      const turn = event.turn as ComposerTurnFact | undefined;
      if (lifecycle === undefined) return undefined;
      if (turn !== undefined && typeof turn.step === 'number') {
        return { agentActivity: { lifecycle, turn: { ...turn, step: Math.max(0, turn.step - 1) } } };
      }
      return { agentActivity: { lifecycle, turn } };
    }
    case 'goal.updated': {
      const snapshot = event.snapshot as
        | { objective?: string; status?: 'active' | 'paused' | 'blocked' | 'complete'; completionCriterion?: string; turnsUsed?: number; budget?: { turnBudget?: number | null } }
        | null
        | undefined;
      if (!snapshot || snapshot.objective === undefined || snapshot.status === undefined) {
        return { goal: null };
      }
      return {
        goal: {
          objective: snapshot.objective,
          status: snapshot.status,
          completionCriterion: snapshot.completionCriterion,
          budgetUsed: snapshot.turnsUsed,
          budgetLimit: snapshot.budget?.turnBudget ?? undefined,
        },
      };
    }
    case 'profile.bind': {
      const model = event.model as string | undefined;
      return model === undefined ? undefined : { status: { model } };
    }
    case 'permission.set_mode': {
      const mode = event.mode as 'manual' | 'yolo' | 'auto' | undefined;
      return mode === undefined ? undefined : { permission: mode };
    }
    default:
      return undefined;
  }
}

export class SessionV2Binder {
  private readonly bindings = new Map<string, SessionV2Binding>();
  constructor(private readonly clock: () => number = Date.now) {}

  peek(sessionId: string): SessionV2Binding | undefined {
    return this.bindings.get(sessionId);
  }

  attach(source: V2SessionSource): SessionV2Binding {
    let binding = this.bindings.get(source.sessionId);
    if (!binding) {
      binding = new SessionV2Binding(source, this.clock);
      this.bindings.set(source.sessionId, binding);
    }
    return binding;
  }

  detach(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (!binding) return;
    this.bindings.delete(sessionId);
    binding.dispose();
  }
}

export class SessionV2Binding {
  readonly projector: SessionV2Projector;
  private readonly agentBindings = new Map<string, AgentV2Binding>();
  private readonly sessionListeners = new Set<(msgs: ServerMessage[]) => void>();
  private readonly seenInteractions = new Map<string, string>();
  private readonly disposables: V2Disposable[] = [];

  constructor(
    private readonly source: V2SessionSource,
    private readonly clock: () => number,
  ) {
    this.projector = new SessionV2Projector(source.sessionId);
    for (const agent of source.agents()) this.watchAgent(agent);
    const created = source.onAgentCreated?.((agentId) => {
      const agent = source.agentFor(agentId);
      if (agent) this.watchAgent(agent);
    });
    if (created) this.disposables.push(created);
    const activity = source.activity;
    if (activity) {
      this.projector.composer.apply({ activity: activity.state() });
      this.disposables.push(
        activity.onDidChange((state, time) => this.emitFacts({ activity: state }, time ?? this.clock())),
      );
    }
    const interactions = source.interactions;
    if (interactions) {
      this.disposables.push(interactions.onDidChangePending((agentId) => this.syncPendingInteractions(agentId)));
      this.disposables.push(
        interactions.onDidResolve((event) => this.applyInteractionResolution(event.agentId, event.id, event.response)),
      );
    }
  }

  private watchAgent(agent: V2AgentSource): void {
    const permission = agent.permissionMode?.();
    if (permission !== undefined) this.projector.composer.apply({ permission });
    this.disposables.push(agent.bus.subscribe((event) => this.onAgentEvent(agent.agentId, event)));
  }

  private factsFlushScheduled = false;
  private factsFlushTime = 0;
  private pendingFacts: SessionFactsPatch[] = [];

  private onAgentEvent(agentId: string, event: V2BusEvent): void {
    const msgs = this.projector.applyAgentEvent(agentId, event);
    if (msgs.length > 0) this.agentFor(agentId).emit(msgs);
    const patch = factsPatchForEvent(event);
    if (patch) this.emitFacts(patch, event.time ?? this.clock());
  }

  private syncPendingInteractions(agentId: string): void {
    const source = this.source.interactions;
    if (!source) return;
    for (const pending of source.listPending(agentId)) {
      if (pending.kind !== 'question') continue;
      if (this.seenInteractions.has(pending.id)) continue;
      this.seenInteractions.set(pending.id, agentId);
      const msgs = this.projector.agentFor(agentId).applyInteractionPending({
        id: pending.id,
        kind: 'question',
        toolCallId: pending.toolCallId,
        request: toWireInteractionRequest('question', pending.request) as never,
        time: this.clock(),
      });
      if (msgs.length > 0) this.agentFor(agentId).emit(msgs);
    }
  }

  private applyInteractionResolution(agentId: string, id: string, response: unknown): void {
    const owner = this.seenInteractions.get(id) ?? agentId;
    if (!this.seenInteractions.has(id)) return;
    const dismissed = response === null || response === undefined;
    const msgs = this.projector.agentFor(owner).applyInteractionResolved({
      id,
      state: dismissed ? 'dismissed' : 'answered',
      response: toWireInteractionResponse('question', response) as never,
      time: this.clock(),
    });
    if (msgs.length > 0) this.agentFor(owner).emit(msgs);
  }

  private emitFacts(patch: SessionFactsPatch, time: number): void {
    this.pendingFacts.push(patch);
    this.factsFlushTime = time;
    if (this.factsFlushScheduled) return;
    this.factsFlushScheduled = true;
    queueMicrotask(() => {
      this.factsFlushScheduled = false;
      const pending = this.pendingFacts.splice(0);
      const last = pending.pop();
      if (last === undefined) return;
      for (const earlier of pending) this.projector.composer.apply(earlier);
      const msgs = this.projector.applyFacts(last, this.factsFlushTime, false);
      if (msgs.length === 0) return;
      for (const listener of this.sessionListeners) listener(msgs);
    });
  }

  agentFor(agentId: string): AgentV2Binding {
    let binding = this.agentBindings.get(agentId);
    if (!binding) {
      binding = new AgentV2Binding(this, agentId);
      this.agentBindings.set(agentId, binding);
    }
    return binding;
  }

  onSessionMessages(listener: (msgs: ServerMessage[]) => void): V2Disposable {
    this.sessionListeners.add(listener);
    return { dispose: () => this.sessionListeners.delete(listener) };
  }

  emitAgentMessages(agentId: string, msgs: ServerMessage[]): void {
    for (const listener of this.agentFor(agentId).listeners) listener(msgs);
  }

  recoveryFor(agentId: string): ServerMessage[] {
    const out = this.projector.agentFor(agentId).recoveryEntities(() => this.clock());
    const composer = this.projector.composer;
    if (composer.hasFacts()) {
      const state = composer.compose(this.clock(), (turnId, step) => `t${turnId + 1}.${step}`);
      if (state) out.push(state);
    }
    return out.filter((msg) => serverMessageSchema.safeParse(msg).success);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export class AgentV2Binding {
  readonly listeners = new Set<(msgs: ServerMessage[]) => void>();
  constructor(
    readonly session: SessionV2Binding,
    readonly agentId: string,
  ) {}

  onMessages(listener: (msgs: ServerMessage[]) => void): V2Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(msgs: ServerMessage[]): void {
    for (const listener of this.listeners) listener(msgs);
  }
}

export function liveSessionSourceFor(core: Scope, sessionId: string): V2SessionSource | undefined {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) return undefined;
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  const agentFor = (context: AgentContext): V2AgentSource => {
    const handle = lifecycle.handleOf(context.agentId);
    const bus = handle?.accessor.get(IEventBus);
    return {
      agentId: context.agentId,
      bus: {
        subscribe: (handler) => {
          if (bus === undefined) return { dispose: () => {} };
          const subscription = bus.subscribe((event: unknown) => handler(event as V2BusEvent));
          return { dispose: () => subscription.dispose() };
        },
      },
      permissionMode: () => handle?.accessor.get(IAgentPermissionModeService)?.mode,
    };
  };
  const interactions: V2InteractionSource = {
    listPending: (agentId) =>
      (lifecycle.handleOf(agentId)?.accessor.get(IAgentInteractionService)?.listPending() ?? []).map(
        (interaction) => ({
          id: interaction.id,
          kind: interaction.kind === 'question' ? ('question' as const) : ('approval' as const),
          request: interaction.payload,
        }),
      ),
    onDidChangePending: (handler) => {
      const store = onSessionInteractionDidChangePending(lifecycle, () => {
        for (const context of lifecycle.list()) handler(context.agentId);
      });
      return { dispose: () => store.dispose() };
    },
    onDidResolve: (handler) => {
      const store = onSessionInteractionDidResolve(lifecycle, (event) => {
        handler({ agentId: 'main', id: event.id, response: event.response });
      });
      return { dispose: () => store.dispose() };
    },
  };
  return {
    sessionId,
    agents: () => lifecycle.list().map((context) => agentFor(context)),
    agentFor: (agentId) => {
      const context = lifecycle.list().find((candidate) => candidate.agentId === agentId);
      return context === undefined ? undefined : agentFor(context);
    },
    onAgentCreated: (handler) => {
      const subscription = lifecycle.onDidCreate((context) => handler(context.agentId));
      return { dispose: () => subscription.dispose() };
    },
    activity: session.accessor.get(ISessionActivityView) === undefined
      ? undefined
      : {
          state: () => session.accessor.get(ISessionActivityView).state(),
          onDidChange: (handler) =>
            session.accessor.get(ISessionActivityView).onDidChange((change) => handler(change.state)),
        },
    interactions,
  };
}
