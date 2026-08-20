import {
  createActor,
  type ActorLogic,
  type AnyActorRef,
  type Snapshot,
} from 'xstate';

import { collection, type CollectionView } from '#/_base/di/collection';
import {
  createDecorator,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { isActiveAgentContext } from '#/agent/agentContext/agentContextIdentity';
import { LifecycleScope } from '#/app/scopes';
import { registerEvent2Class, type Event2, type Event2Class } from '#/app/event/event2';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { StateFold } from '#/state/state';

export type AgentRuntimeStatus = 'registered' | 'materialized' | 'done' | 'failed' | 'retired';

export interface AgentRuntimeIdentity {
  readonly agentId: string;
  readonly generation: number;
}

export interface AgentRuntimeContext<State> {
  readonly agent: AgentContext;
  get<T>(id: ServiceIdentifier<T>): T;
  getState(): State;
  dispatch(event: Event2<any>): Promise<void>;
  readonly onDidChange: Event<State>;
}

export interface AgentRuntimeDurableDefinition<State> {
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  read(snapshot: Snapshot<unknown>): State;
  commit(actor: AnyActorRef, state: State): void;
}

export interface AgentRuntimeDefinition<State, Facade> {
  readonly id: string;
  readonly logic: ActorLogic<any, any, any>;
  readonly input?: (agent: AgentContext) => unknown;
  readonly durable: AgentRuntimeDurableDefinition<State>;
  readonly createFacade: (
    actor: AnyActorRef,
    context: AgentRuntimeContext<State>,
  ) => Facade;
  readonly activate?: (
    actor: AnyActorRef,
    context: AgentRuntimeContext<State>,
  ) => void;
  readonly inspect?: (snapshot: Snapshot<unknown>) => unknown;
}

export function defineAgentRuntime<State, Facade>(
  definition: AgentRuntimeDefinition<State, Facade>,
): AgentRuntimeDefinition<State, Facade> {
  for (const cls of definition.durable.events) registerEvent2Class(cls);
  return Object.freeze(definition);
}

export const AgentRuntimeContributionPoint = collection<AgentRuntimeDefinition<any, any>>(
  'agent-runtime',
  {
    validate: (value, existing) => {
      if (existing.some((definition) => definition.id === value.id)) {
        throw new Error(`Agent runtime '${value.id}' already has an active provider`);
      }
    },
  },
);

export interface AgentRuntimeContributionSnapshot {
  readonly id: string;
  readonly generation: number;
  readonly status: AgentRuntimeStatus;
  readonly state?: unknown;
  readonly error?: string;
}

export interface AgentRuntimeSnapshot {
  readonly identity: AgentRuntimeIdentity;
  readonly contributions: readonly AgentRuntimeContributionSnapshot[];
}

export interface DurableAgentRuntimeParticipant<State = any> {
  readonly id: string;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  getState(): State;
  commit(state: State): void;
}

interface RuntimeRecord {
  readonly definition: AgentRuntimeDefinition<any, any>;
  readonly generation: number;
  active: boolean;
}

interface RuntimeEntry {
  readonly record: RuntimeRecord;
  status: AgentRuntimeStatus;
  actor?: AnyActorRef;
  facade?: unknown;
  activated: boolean;
  listeners?: Set<(state: any) => void>;
  subscription?: { unsubscribe(): void };
  error?: unknown;
}

interface AgentEntry {
  readonly agent: AgentContext;
  readonly runtimes: Map<string, RuntimeEntry>;
}

export class AgentRuntimeHost {
  private readonly definitions = new Map<string, RuntimeRecord>();
  private readonly definitionGenerations = new Map<string, number>();
  private readonly agents = new Map<string, AgentEntry>();
  private disposed = false;

  constructor(
    private readonly accessorFor: (agent: AgentContext) => ServicesAccessor | undefined = () => undefined,
  ) {}

  register(definition: AgentRuntimeDefinition<any, any>): { withdraw(): void } {
    if (this.disposed) throw new Error('Agent runtime host is disposed');
    if (this.definitions.has(definition.id)) {
      throw new Error(`Agent runtime '${definition.id}' already exists`);
    }
    for (const cls of definition.durable.events) registerEvent2Class(cls);
    const generation = (this.definitionGenerations.get(definition.id) ?? 0) + 1;
    this.definitionGenerations.set(definition.id, generation);
    const record = { definition, generation, active: true };
    this.definitions.set(definition.id, record);
    return { withdraw: () => { this.withdraw(record); } };
  }

  resolve<State, Facade>(
    agent: AgentContext,
    definition: AgentRuntimeDefinition<State, Facade>,
    scopeAccessor?: ServicesAccessor,
  ): Facade {
    this.requireActiveContext(agent);
    const accessor = scopeAccessor ?? this.requireAccessor(agent);
    const entry = this.materialize(agent, definition);
    if (entry.facade !== undefined) return entry.facade as Facade;
    const actor = entry.actor!;
    const listeners = entry.listeners! as Set<(state: State) => void>;
    const context: AgentRuntimeContext<State> = {
      agent,
      get: (id) => accessor.get(id),
      getState: () => definition.durable.read(actor.getSnapshot()),
      dispatch: (event) => accessor.get(IEventDispatcher).dispatch(event),
      onDidChange: (listener) => {
        listeners.add(listener);
        return toDisposable(() => { listeners.delete(listener); });
      },
    };
    try {
      entry.facade = definition.createFacade(actor, context);
      if (!entry.activated) {
        definition.activate?.(actor, context);
        entry.activated = true;
      }
      return entry.facade as Facade;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      throw error;
    }
  }

  participants(agent: AgentContext): readonly DurableAgentRuntimeParticipant[] {
    this.requireActiveContext(agent);
    return [...this.definitions.values()].map((record) =>
      this.participant(this.materialize(agent, record.definition)));
  }

  snapshot(agent: AgentContext): AgentRuntimeSnapshot {
    this.requireActiveContext(agent);
    const current = this.agentEntry(agent, false);
    const entries = new Map<string, RuntimeEntry>();
    for (const record of this.definitions.values()) {
      const existing = current?.runtimes.get(record.definition.id);
      entries.set(record.definition.id, existing?.record === record ? existing : {
        record,
        status: 'registered',
        activated: false,
      });
    }
    if (current !== undefined) {
      for (const [id, entry] of current.runtimes) {
        if (!entries.has(id)) entries.set(id, entry);
      }
    }
    return {
      identity: { agentId: agent.agentId, generation: agent.generation },
      contributions: [...entries.values()].map((entry) => ({
        id: entry.record.definition.id,
        generation: entry.record.generation,
        status: entry.status,
        state: entry.actor === undefined
          ? undefined
          : this.project(entry.record.definition, entry.actor.getSnapshot()),
        error: serializeError(entry.error),
      })),
    };
  }

  disposeAgent(agent: AgentContext): void {
    const entry = this.agents.get(this.agentKey(agent));
    if (entry === undefined || entry.agent !== agent) return;
    for (const runtime of entry.runtimes.values()) this.disposeRuntime(runtime, 'retired');
    this.agents.delete(this.agentKey(agent));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.agents.values()) {
      for (const runtime of entry.runtimes.values()) this.disposeRuntime(runtime, 'retired');
    }
    this.agents.clear();
    this.definitions.clear();
  }

  private materialize<State, Facade>(
    agent: AgentContext,
    definition: AgentRuntimeDefinition<State, Facade>,
  ): RuntimeEntry {
    this.requireActiveContext(agent);
    if (this.disposed) throw new Error('Agent runtime host is disposed');
    const record = this.definitions.get(definition.id);
    if (record === undefined || record.definition !== definition || !record.active) {
      throw new Error(`Agent runtime '${definition.id}' is unavailable`);
    }
    const agentEntry = this.agentEntry(agent, true)!;
    const existing = agentEntry.runtimes.get(definition.id);
    if (existing !== undefined) {
      if (existing.record === record && existing.status !== 'retired') return existing;
      this.disposeRuntime(existing, 'retired');
    }
    const entry: RuntimeEntry = { record, status: 'registered', activated: false };
    agentEntry.runtimes.set(definition.id, entry);
    try {
      const actor = createActor(definition.logic, { input: definition.input?.(agent) });
      const listeners = new Set<(state: State) => void>();
      entry.actor = actor;
      entry.listeners = listeners;
      let previous: State;
      entry.subscription = actor.subscribe({
        next: (snapshot) => {
          if (snapshot.status === 'done') entry.status = 'done';
          if (snapshot.status === 'error') {
            entry.status = 'failed';
            entry.error = snapshot.error;
          }
          const next = definition.durable.read(snapshot);
          if (Object.is(previous, next)) return;
          if (previous !== undefined) {
            for (const listener of listeners) listener(next);
          }
          previous = next;
        },
        error: (error) => {
          entry.status = 'failed';
          entry.error = error;
        },
      });
      actor.start();
      previous = definition.durable.read(actor.getSnapshot());
      if (entry.status === 'registered') entry.status = 'materialized';
      return entry;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      entry.subscription?.unsubscribe();
      entry.actor?.stop();
      throw error;
    }
  }

  private participant(entry: RuntimeEntry): DurableAgentRuntimeParticipant {
    const actor = entry.actor;
    if (actor === undefined) throw new Error(`Agent runtime '${entry.record.definition.id}' failed`);
    const definition = entry.record.definition;
    return {
      id: definition.id,
      events: definition.durable.events,
      undoable: definition.durable.undoable,
      transition: definition.durable.transition,
      getState: () => definition.durable.read(actor.getSnapshot()),
      commit: (state) => { definition.durable.commit(actor, state); },
    };
  }

  private agentEntry(agent: AgentContext, create: boolean): AgentEntry | undefined {
    const key = this.agentKey(agent);
    let entry = this.agents.get(key);
    if (entry !== undefined && entry.agent !== agent) {
      throw new Error(`Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`);
    }
    if (entry === undefined && create) {
      entry = { agent, runtimes: new Map() };
      this.agents.set(key, entry);
    }
    return entry;
  }

  private requireActiveContext(agent: AgentContext): void {
    if (!isActiveAgentContext(agent)) {
      throw new Error(`Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`);
    }
    const entry = this.agents.get(this.agentKey(agent));
    if (entry !== undefined && entry.agent !== agent) {
      throw new Error(`Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`);
    }
  }

  private requireAccessor(agent: AgentContext): ServicesAccessor {
    this.requireActiveContext(agent);
    const accessor = this.accessorFor(agent);
    if (accessor === undefined) {
      throw new Error(`Agent ${agent.agentId}:${String(agent.generation)} is stale`);
    }
    return accessor;
  }

  private agentKey(agent: AgentContext): string {
    return `${agent.agentId}:${String(agent.generation)}`;
  }

  private withdraw(record: RuntimeRecord): void {
    if (!record.active) return;
    record.active = false;
    if (this.definitions.get(record.definition.id) === record) {
      this.definitions.delete(record.definition.id);
    }
    for (const agent of this.agents.values()) {
      const entry = agent.runtimes.get(record.definition.id);
      if (entry?.record === record) this.disposeRuntime(entry, 'retired');
    }
  }

  private disposeRuntime(entry: RuntimeEntry, status: AgentRuntimeStatus): void {
    if (entry.status === 'retired') return;
    entry.subscription?.unsubscribe();
    entry.actor?.stop();
    entry.subscription = undefined;
    entry.actor = undefined;
    entry.facade = undefined;
    entry.listeners = undefined;
    entry.status = status;
  }

  private project(
    definition: AgentRuntimeDefinition<any, any>,
    snapshot: Snapshot<unknown>,
  ): unknown {
    return definition.inspect === undefined
      ? definition.durable.read(snapshot)
      : definition.inspect(snapshot);
  }
}

export interface IAgentRuntimeHostService {
  readonly _serviceBrand: undefined;
  resolve<State, Facade>(
    agent: AgentContext,
    definition: AgentRuntimeDefinition<State, Facade>,
    scopeAccessor?: ServicesAccessor,
  ): Facade;
  participants(agent: AgentContext): readonly DurableAgentRuntimeParticipant[];
  snapshot(agent: AgentContext): AgentRuntimeSnapshot;
  inspect(agent: AgentContext): AgentRuntimeSnapshot;
  disposeAgent(agent: AgentContext): void;
}

export const IAgentRuntimeHostService: ServiceIdentifier<IAgentRuntimeHostService> =
  createDecorator<IAgentRuntimeHostService>('agentRuntimeHostService');

export class AgentRuntimeHostService extends Service implements IAgentRuntimeHostService {
  declare readonly _serviceBrand: undefined;

  private readonly host: AgentRuntimeHost;
  private readonly registrations = new Map<AgentRuntimeDefinition<any, any>, { withdraw(): void }>();

  constructor(
    @AgentRuntimeContributionPoint definitions: CollectionView<AgentRuntimeDefinition<any, any>>,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
  ) {
    super();
    this.host = new AgentRuntimeHost((agent) => lifecycle.get(agent)?.accessor);
    for (const definition of definitions.items) this.registerDefinition(definition);
    this._register(definitions.onDidChange(({ added, removed }) => {
      for (const definition of added) this.registerDefinition(definition);
      for (const definition of removed) this.withdrawDefinition(definition);
    }));
    this._register(lifecycle.onDidDispose((agent) => { this.disposeAgent(agent); }));
    this._register(toDisposable(() => { this.host.dispose(); }));
  }

  resolve<State, Facade>(
    agent: AgentContext,
    definition: AgentRuntimeDefinition<State, Facade>,
    scopeAccessor?: ServicesAccessor,
  ): Facade {
    return this.host.resolve(agent, definition, scopeAccessor);
  }

  participants(agent: AgentContext): readonly DurableAgentRuntimeParticipant[] {
    return this.host.participants(agent);
  }

  snapshot(agent: AgentContext): AgentRuntimeSnapshot {
    return this.host.snapshot(agent);
  }

  inspect(agent: AgentContext): AgentRuntimeSnapshot {
    return this.snapshot(agent);
  }

  disposeAgent(agent: AgentContext): void {
    this.host.disposeAgent(agent);
  }

  private registerDefinition(definition: AgentRuntimeDefinition<any, any>): void {
    this.registrations.set(definition, this.host.register(definition));
  }

  private withdrawDefinition(definition: AgentRuntimeDefinition<any, any>): void {
    this.registrations.get(definition)?.withdraw();
    this.registrations.delete(definition);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentRuntimeHostService,
  AgentRuntimeHostService,
  ScopeActivation.OnScopeCreated,
  'agentRuntime',
);

function serializeError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown runtime error';
}
