import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { Emitter, type Event } from '#/_base/event';
import {
  AgentActorService,
  type AgentActorContext,
} from '#/agent/actorService/agentActorService';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { registerEvent2Class } from '#/app/event/event2';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
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

registerEvent2Class(InteractionRequestEvent);
registerEvent2Class(InteractionResolvedEvent);

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

interface PendingEntry {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

interface InteractionEffectState {
  readonly pending: Map<string, PendingEntry>;
  readonly recentlyResolved: Map<string, number>;
  nextId: number;
  readonly changeEmitter: Emitter<InteractionPendingChangedEvent>;
  readonly resolveEmitter: Emitter<InteractionResolution>;
}

interface InteractionActorContext {
  readonly records: InteractionModelState;
  readonly effects: InteractionEffectState;
  readonly runtime: AgentActorContext<InteractionModelState>;
}

interface InteractionCommitEvent {
  readonly type: 'interaction.commit';
  readonly records: InteractionModelState;
}

type InteractionActorSnapshot = Snapshot<unknown> & { readonly context: InteractionActorContext };

function rememberResolved(effects: InteractionEffectState, id: string): void {
  const now = Date.now();
  for (const [key, resolvedAt] of effects.recentlyResolved) {
    if (now - resolvedAt > RECENTLY_RESOLVED_TTL_MS) effects.recentlyResolved.delete(key);
  }
  while (effects.recentlyResolved.size >= RECENTLY_RESOLVED_MAX) {
    const oldest = effects.recentlyResolved.keys().next().value;
    if (oldest === undefined) break;
    effects.recentlyResolved.delete(oldest);
  }
  effects.recentlyResolved.set(id, now);
}

function recordResolved(runtime: AgentActorContext<InteractionModelState>, id: string, response: unknown): void {
  void runtime.dispatch(
    new InteractionResolvedEvent({
      agentId: runtime.agent.agentId,
      id,
      response,
    }),
  );
}

function cancelTurnPending(
  runtime: AgentActorContext<InteractionModelState>,
  effects: InteractionEffectState,
  turnId: number,
): void {
  let changed = false;
  for (const [id, entry] of effects.pending) {
    if (entry.interaction.origin?.turnId !== turnId) continue;
    effects.pending.delete(id);
    rememberResolved(effects, id);
    const response = { cancelled: true, reason: 'turn_ended' };
    entry.resolve(response);
    recordResolved(runtime, id, response);
    effects.resolveEmitter.fire({ id, response });
    changed = true;
  }
  if (changed) effects.changeEmitter.fire({ pending: [...effects.pending.keys()] });
}

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}

const interactionEffects = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentActorContext<InteractionModelState>;
    readonly effects: InteractionEffectState;
  };
}) => {
  const subscription = input.runtime.get(IEventBus).subscribe(TurnEnded, (e) => {
    cancelTurnPending(input.runtime, input.effects, e.turnId);
  });
  return () => {
    subscription.dispose();
    for (const entry of input.effects.pending.values()) {
      entry.resolve({ cancelled: true, reason: 'agent_closed' });
    }
    input.effects.pending.clear();
    input.effects.changeEmitter.dispose();
    input.effects.resolveEmitter.dispose();
  };
});

const interactionActorLogic = setup({
  types: {} as {
    context: InteractionActorContext;
    input: AgentActorContext<InteractionModelState>;
    events: InteractionCommitEvent;
  },
  actors: { interactionEffects },
}).createMachine({
  context: ({ input }) => ({
    records: new Map(),
    effects: {
      pending: new Map(),
      recentlyResolved: new Map(),
      nextId: 0,
      changeEmitter: new Emitter(),
      resolveEmitter: new Emitter(),
    },
    runtime: input,
  }),
  invoke: {
    src: 'interactionEffects',
    input: ({ context }) => ({ runtime: context.runtime, effects: context.effects }),
  },
  on: {
    'interaction.commit': {
      actions: assign({ records: ({ event }) => event.records }),
    },
  },
});

export interface IAgentInteractionService {
  readonly _serviceBrand: undefined;
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): boolean;
  listPending(kind?: InteractionKind): readonly Interaction[];
  isRecentlyResolved(id: string): boolean;
  cancelPendingForTurn(turnId: number): void;
}

export const IAgentInteractionService = createDecorator<IAgentInteractionService>('agentInteractionService');

export class AgentInteractionService extends AgentActorService<InteractionModelState> implements IAgentInteractionService {
  declare readonly _serviceBrand: undefined;
  readonly onDidChangePending: IAgentInteractionService['onDidChangePending'];
  readonly onDidResolve: IAgentInteractionService['onDidResolve'];

  private readonly actor: AgentActorContext<InteractionModelState>;
  private readonly effects: InteractionEffectState;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.actor = this.attachActor(interactionActorLogic, {
      id: 'interaction',
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
    });
    this.effects = this.actor.getLogicState<InteractionActorContext>().effects;
    this.onDidChangePending = this.effects.changeEmitter.event;
    this.onDidResolve = this.effects.resolveEmitter.event;
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
    const entry = this.effects.pending.get(id);
    if (entry === undefined) return false;
    this.effects.pending.delete(id);
    rememberResolved(this.effects, id);
    entry.resolve(response);
    recordResolved(this.actor, id, response);
    this.effects.changeEmitter.fire({ pending: [...this.effects.pending.keys()] });
    this.effects.resolveEmitter.fire({ id, response });
    return true;
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const all = [...this.effects.pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
  }

  isRecentlyResolved(id: string): boolean {
    const resolvedAt = this.effects.recentlyResolved.get(id);
    if (resolvedAt === undefined) return false;
    if (Date.now() - resolvedAt > RECENTLY_RESOLVED_TTL_MS) {
      this.effects.recentlyResolved.delete(id);
      return false;
    }
    return true;
  }

  cancelPendingForTurn(turnId: number): void {
    cancelTurnPending(this.actor, this.effects, turnId);
  }

  private park<TPayload>(
    req: InteractionRequest<TPayload>,
    resolve: (response: unknown) => void,
  ): Interaction {
    const id = req.id ?? `${this.actor.agent.agentId}:interaction-${this.effects.nextId++}`;
    if (this.effects.pending.has(id)) throw new Error(`Interaction "${id}" is already pending`);
    const interaction: Interaction<TPayload> = {
      id,
      kind: req.kind,
      payload: req.payload,
      origin: req.origin ?? {},
      createdAt: Date.now(),
    };
    this.effects.pending.set(id, { interaction, resolve });
    void this.actor.dispatch(
      new InteractionRequestEvent({
        agentId: this.actor.agent.agentId,
        id: interaction.id,
        kind: interaction.kind,
        toolCallId: readPayloadToolCallId(interaction.payload),
        request: interaction.payload,
      }),
    );
    this.effects.changeEmitter.fire({ pending: [...this.effects.pending.keys()] });
    return interaction;
  }
}
