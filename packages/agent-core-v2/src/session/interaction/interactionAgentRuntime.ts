import { assign, fromCallback, setup, type AnyActorRef, type EventObject, type Snapshot } from 'xstate';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { TurnEnded } from '#/agent/loop/turnOps';
import { type AgentRuntimeContext, defineAgentRuntime } from '#/agent/runtime/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentManager } from '#/session/agentManager/agentManager';

import {
  AgentInteraction,
  IAgentInteraction,
  type Interaction,
  type InteractionKind,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
} from './interaction';
import {
  InteractionRequestEvent,
  InteractionResolvedEvent,
  type InteractionModelState,
} from './interactionOps';

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

interface PendingEntry {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

interface InteractionActivation {
  readonly runtime: AgentRuntimeContext<InteractionModelState>;
  readonly core: InteractionCore;
}

interface InteractionActorContext {
  readonly records: InteractionModelState;
  readonly activation?: InteractionActivation;
}

interface InteractionCommitEvent {
  readonly type: 'interaction.commit';
  readonly records: InteractionModelState;
}

interface InteractionActivateEvent {
  readonly type: 'interaction.activate';
  readonly activation: InteractionActivation;
}

type InteractionActorEvent = InteractionCommitEvent | InteractionActivateEvent;

type InteractionActorSnapshot = Snapshot<unknown> & { readonly context: InteractionActorContext };

class InteractionCore {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly recentlyResolved = new Map<string, number>();
  private nextId = 0;
  private readonly changeEmitter = new Emitter<InteractionPendingChangedEvent>();
  private readonly resolveEmitter = new Emitter<InteractionResolution>();

  readonly onDidChangePending: Event<InteractionPendingChangedEvent> = this.changeEmitter.event;
  readonly onDidResolve: Event<InteractionResolution> = this.resolveEmitter.event;

  constructor(private readonly runtime: AgentRuntimeContext<InteractionModelState>) {}

  attach(): () => void {
    const store = new DisposableStore();
    store.add(this.changeEmitter);
    store.add(this.resolveEmitter);
    store.add(
      this.runtime.get(IEventBus).subscribe(TurnEnded, (e) => this.cancelPendingForTurn(e.turnId)),
    );
    return () => store.dispose();
  }

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      this.park(req, resolve as (response: unknown) => void);
    });
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return this.park(req, () => {});
  }

  respond(id: string, response: unknown): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    this.rememberResolved(id);
    entry.resolve(response);
    this.recordResolved(id, response);
    this.changeEmitter.fire({ pending: [...this.pending.keys()] });
    this.resolveEmitter.fire({ id, response });
    return true;
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const all = [...this.pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
  }

  isRecentlyResolved(id: string): boolean {
    const resolvedAt = this.recentlyResolved.get(id);
    if (resolvedAt === undefined) return false;
    if (Date.now() - resolvedAt > RECENTLY_RESOLVED_TTL_MS) {
      this.recentlyResolved.delete(id);
      return false;
    }
    return true;
  }

  cancelPendingForTurn(turnId: number): void {
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (entry.interaction.origin?.turnId !== turnId) continue;
      this.pending.delete(id);
      this.rememberResolved(id);
      const response = { cancelled: true, reason: 'turn_ended' };
      entry.resolve(response);
      this.recordResolved(id, response);
      this.resolveEmitter.fire({ id, response });
      changed = true;
    }
    if (changed) {
      this.changeEmitter.fire({ pending: [...this.pending.keys()] });
    }
  }

  private park<TPayload>(
    req: InteractionRequest<TPayload>,
    resolve: (response: unknown) => void,
  ): Interaction {
    const id = req.id ?? `interaction-${this.nextId++}`;
    const interaction: Interaction<TPayload> = {
      id,
      kind: req.kind,
      payload: req.payload,
      origin: req.origin ?? {},
      createdAt: Date.now(),
    };
    this.pending.set(id, { interaction, resolve });
    void this.runtime.dispatch(
      new InteractionRequestEvent({
        agentId: this.runtime.agent.agentId,
        id: interaction.id,
        kind: interaction.kind,
        toolCallId: readPayloadToolCallId(interaction.payload),
        request: interaction.payload,
      }),
    );
    this.changeEmitter.fire({ pending: [...this.pending.keys()] });
    return interaction;
  }

  private recordResolved(id: string, response: unknown): void {
    void this.runtime.dispatch(
      new InteractionResolvedEvent({
        agentId: this.runtime.agent.agentId,
        id,
        response,
      }),
    );
  }

  private rememberResolved(id: string): void {
    const now = Date.now();
    for (const [key, resolvedAt] of this.recentlyResolved) {
      if (now - resolvedAt > RECENTLY_RESOLVED_TTL_MS) this.recentlyResolved.delete(key);
    }
    while (this.recentlyResolved.size >= RECENTLY_RESOLVED_MAX) {
      const oldest = this.recentlyResolved.keys().next().value;
      if (oldest === undefined) break;
      this.recentlyResolved.delete(oldest);
    }
    this.recentlyResolved.set(id, now);
  }
}

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}

const interactionEffectLogic = fromCallback<EventObject, InteractionActivation>(({ input }) =>
  input.core.attach(),
);

const interactionActorLogic = setup({
  types: {} as {
    context: InteractionActorContext;
    events: InteractionActorEvent;
  },
  actors: {
    effect: interactionEffectLogic,
  },
}).createMachine({
  context: { records: new Map() },
  initial: 'inactive',
  on: {
    'interaction.commit': {
      actions: assign({ records: ({ event }) => event.records }),
    },
  },
  states: {
    inactive: {
      on: {
        'interaction.activate': {
          target: 'active',
          actions: assign({ activation: ({ event }) => event.activation }),
        },
      },
    },
    active: {
      invoke: {
        src: 'effect',
        input: ({ context }) => context.activation!,
      },
    },
  },
});

const cores = new WeakMap<AnyActorRef, InteractionCore>();

export const InteractionAgentRuntimeDefinition = defineAgentRuntime<
  InteractionModelState,
  IAgentInteraction
>({
  id: 'interaction',
  logic: interactionActorLogic,
  durable: {
    events: [InteractionRequestEvent, InteractionResolvedEvent],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof InteractionRequestEvent) {
        state.set(event.id, {
          id: event.id,
          kind: event.kind,
          toolCallId: event.toolCallId,
          agentId: event.agentId,
          request: event.request,
          resolved: false,
        });
        return;
      }
      if (event instanceof InteractionResolvedEvent) {
        const existing = state.get(event.id);
        if (existing === undefined) return;
        state.set(event.id, { ...existing, resolved: true, response: event.response });
      }
    },
    read: (snapshot) => (snapshot as InteractionActorSnapshot).context.records,
    commit: (actor, records) => { actor.send({ type: 'interaction.commit', records }); },
  },
  createFacade: (actor, context) => {
    const core = new InteractionCore(context);
    cores.set(actor, core);
    return {
      _serviceBrand: undefined,
      request: (req) => core.request(req),
      enqueue: (req) => core.enqueue(req),
      respond: (id, response) => core.respond(id, response),
      listPending: (kind) => core.listPending(kind),
      isRecentlyResolved: (id) => core.isRecentlyResolved(id),
      cancelPendingForTurn: (turnId) => core.cancelPendingForTurn(turnId),
      onDidChangePending: core.onDidChangePending,
      onDidResolve: core.onDidResolve,
    };
  },
  activate: (actor, context) => {
    actor.send({
      type: 'interaction.activate',
      activation: { runtime: context, core: cores.get(actor)! },
    });
  },
  inspect: (snapshot) => {
    const records = (snapshot as InteractionActorSnapshot).context.records;
    return [...records.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      resolved: record.resolved,
    }));
  },
});

export class AgentInteractionBinding implements IAgentInteraction {
  declare readonly _serviceBrand: undefined;

  private readonly interaction: IAgentInteraction;

  constructor(
    @IAgentManager manager: IAgentManager,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.interaction = manager.resolve(scope.agentContext, AgentInteraction);
  }

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return this.interaction.request(req);
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return this.interaction.enqueue(req);
  }

  respond(id: string, response: unknown): boolean {
    return this.interaction.respond(id, response);
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    return this.interaction.listPending(kind);
  }

  isRecentlyResolved(id: string): boolean {
    return this.interaction.isRecentlyResolved(id);
  }

  cancelPendingForTurn(turnId: number): void {
    this.interaction.cancelPendingForTurn(turnId);
  }

  get onDidChangePending() {
    return this.interaction.onDidChangePending;
  }

  get onDidResolve() {
    return this.interaction.onDidResolve;
  }
}
