import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import { Emitter, type Event } from '#/_base/event';
import { TurnEnded } from '#/actor/loop/turnOps';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';
import { IAgentHostService } from '#/agent/host/agentHost';

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

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

interface PendingEntry {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

interface InteractionActorContext {
  readonly records: InteractionModelState;
  readonly runtime: AgentRuntimeContext<InteractionModelState>;
  readonly pending: ReadonlyMap<string, PendingEntry>;
  readonly recentlyResolved: ReadonlyMap<string, number>;
  readonly nextId: number;
  readonly changeEmitter: Emitter<InteractionPendingChangedEvent>;
  readonly resolveEmitter: Emitter<InteractionResolution>;
}

interface InteractionCommitEvent {
  readonly type: 'interaction.commit';
  readonly records: InteractionModelState;
}

interface InteractionParkedEvent {
  readonly type: 'interaction.parked';
  readonly entry: PendingEntry;
  readonly allocatedId: boolean;
}

interface InteractionSettledEvent {
  readonly type: 'interaction.settled';
  readonly id: string;
  readonly at: number;
}

type InteractionActorEvent = InteractionCommitEvent | InteractionParkedEvent | InteractionSettledEvent;

type InteractionActorSnapshot = Snapshot<unknown> & { readonly context: InteractionActorContext };

function pendingWith(
  pending: ReadonlyMap<string, PendingEntry>,
  entry: PendingEntry,
): ReadonlyMap<string, PendingEntry> {
  const next = new Map(pending);
  next.set(entry.interaction.id, entry);
  return next;
}

function pendingWithout(
  pending: ReadonlyMap<string, PendingEntry>,
  id: string,
): ReadonlyMap<string, PendingEntry> {
  const next = new Map(pending);
  next.delete(id);
  return next;
}

function foldRecentlyResolved(
  recentlyResolved: ReadonlyMap<string, number>,
  id: string,
  at: number,
): ReadonlyMap<string, number> {
  const next = new Map(recentlyResolved);
  for (const [key, resolvedAt] of next) {
    if (at - resolvedAt > RECENTLY_RESOLVED_TTL_MS) next.delete(key);
  }
  while (next.size >= RECENTLY_RESOLVED_MAX) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  next.set(id, at);
  return next;
}

function contextOf(runtime: AgentRuntimeContext<InteractionModelState>): InteractionActorContext {
  return runtime.getLogicState<InteractionActorContext>();
}

function tryContextOf(
  runtime: AgentRuntimeContext<InteractionModelState>,
): InteractionActorContext | undefined {
  try {
    return runtime.getLogicState<InteractionActorContext>();
  } catch {
    return undefined;
  }
}

function recordResolved(runtime: AgentRuntimeContext<InteractionModelState>, id: string, response: unknown): void {
  void runtime.dispatch(
    new InteractionResolvedEvent({
      agentId: runtime.agent.agentId,
      id,
      response,
    }),
  );
}

function parkInteraction(
  runtime: AgentRuntimeContext<InteractionModelState>,
  req: InteractionRequest<unknown>,
  resolve: (response: unknown) => void,
): Interaction {
  const context = contextOf(runtime);
  const allocatedId = req.id === undefined;
  const id = req.id ?? `${runtime.agent.agentId}:interaction-${context.nextId}`;
  if (context.pending.has(id)) throw new Error(`Interaction "${id}" is already pending`);
  const interaction: Interaction = {
    id,
    kind: req.kind,
    payload: req.payload,
    origin: req.origin ?? {},
    createdAt: Date.now(),
  };
  runtime.send({ type: 'interaction.parked', entry: { interaction, resolve }, allocatedId });
  void runtime.dispatch(
    new InteractionRequestEvent({
      agentId: runtime.agent.agentId,
      id: interaction.id,
      kind: interaction.kind,
      toolCallId: readPayloadToolCallId(interaction.payload),
      request: interaction.payload,
    }),
  );
  context.changeEmitter.fire({ pending: [...contextOf(runtime).pending.keys()] });
  return interaction;
}

function respondInteraction(
  runtime: AgentRuntimeContext<InteractionModelState>,
  id: string,
  response: unknown,
): boolean {
  const context = tryContextOf(runtime);
  const entry = context?.pending.get(id);
  if (context === undefined || entry === undefined) return false;
  runtime.send({ type: 'interaction.settled', id, at: Date.now() });
  entry.resolve(response);
  recordResolved(runtime, id, response);
  context.changeEmitter.fire({ pending: [...contextOf(runtime).pending.keys()] });
  context.resolveEmitter.fire({ id, response });
  return true;
}

function cancelTurnPending(
  runtime: AgentRuntimeContext<InteractionModelState>,
  turnId: number,
): void {
  const context = tryContextOf(runtime);
  if (context === undefined) return;
  let changed = false;
  for (const entry of context.pending.values()) {
    if (entry.interaction.origin?.turnId !== turnId) continue;
    const id = entry.interaction.id;
    const response = { cancelled: true, reason: 'turn_ended' };
    runtime.send({ type: 'interaction.settled', id, at: Date.now() });
    entry.resolve(response);
    recordResolved(runtime, id, response);
    context.resolveEmitter.fire({ id, response });
    changed = true;
  }
  if (changed) context.changeEmitter.fire({ pending: [...contextOf(runtime).pending.keys()] });
}

export class InteractionRuntime {
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;

  constructor(private readonly runtime: AgentRuntimeContext<InteractionModelState>) {
    const context = contextOf(runtime);
    this.onDidChangePending = context.changeEmitter.event;
    this.onDidResolve = context.resolveEmitter.event;
  }

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      parkInteraction(this.runtime, req, resolve as (response: unknown) => void);
    });
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return parkInteraction(this.runtime, req, () => {});
  }

  respond(id: string, response: unknown): boolean {
    return respondInteraction(this.runtime, id, response);
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const pending = tryContextOf(this.runtime)?.pending;
    if (pending === undefined) return [];
    const all = [...pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
  }

  isRecentlyResolved(id: string): boolean {
    const resolvedAt = tryContextOf(this.runtime)?.recentlyResolved.get(id);
    if (resolvedAt === undefined) return false;
    return Date.now() - resolvedAt <= RECENTLY_RESOLVED_TTL_MS;
  }

  cancelPendingForTurn(turnId: number): void {
    cancelTurnPending(this.runtime, turnId);
  }
}

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}

const interactionEffects = fromCallback(({
  input,
}: {
  input: AgentRuntimeContext<InteractionModelState>;
}) => {
  const subscription = input.get(IAgentHostService).of(input.agent).eventBus.subscribe(TurnEnded, (e) => {
    cancelTurnPending(input, e.turnId);
  });
  return () => {
    subscription.dispose();
    const context = contextOf(input);
    for (const entry of context.pending.values()) {
      entry.resolve({ cancelled: true, reason: 'agent_closed' });
    }
    context.changeEmitter.dispose();
    context.resolveEmitter.dispose();
  };
});

const interactionActorLogic = setup({
  types: {} as {
    context: InteractionActorContext;
    input: AgentRuntimeContext<InteractionModelState>;
    events: InteractionActorEvent;
  },
  actors: { interactionEffects },
}).createMachine({
  context: ({ input }) => ({
    records: new Map(),
    runtime: input,
    pending: new Map(),
    recentlyResolved: new Map(),
    nextId: 0,
    changeEmitter: new Emitter(),
    resolveEmitter: new Emitter(),
  }),
  invoke: {
    src: 'interactionEffects',
    input: ({ context }) => context.runtime,
  },
  on: {
    'interaction.commit': {
      actions: assign({ records: ({ event }) => event.records }),
    },
    'interaction.parked': {
      actions: assign(({ context, event }) => ({
        pending: pendingWith(context.pending, event.entry),
        nextId: event.allocatedId ? context.nextId + 1 : context.nextId,
      })),
    },
    'interaction.settled': {
      actions: assign(({ context, event }) => {
        if (!context.pending.has(event.id)) return {};
        return {
          pending: pendingWithout(context.pending, event.id),
          recentlyResolved: foldRecentlyResolved(context.recentlyResolved, event.id, event.at),
        };
      }),
    },
  },
});

export const AgentInteraction = defineAgentRuntimeContract<InteractionRuntime>('interaction');

export const interactionAgentRuntimeProvider = defineAgentRuntimeProvider<InteractionModelState, InteractionRuntime>(AgentInteraction, {
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
  createApi: (context) => new InteractionRuntime(context),
  inspect: (snapshot) => {
    const records = (snapshot as InteractionActorSnapshot).context.records;
    return [...records.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      resolved: record.resolved,
    }));
  },
});
