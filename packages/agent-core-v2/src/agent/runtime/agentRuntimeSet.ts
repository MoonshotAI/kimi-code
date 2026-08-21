import { createActor, type AnyActorRef } from 'xstate';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { BugIndicatingError } from '#/_base/errors/errors';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IEventDispatcher, type DurableRuntimeParticipantHost } from '#/state/eventDispatcher';

import {
  AgentRuntimeLifecycle,
  type AgentRuntimeContext,
  type AgentRuntimeContributionSnapshot,
  type AgentRuntimeDefinition,
  type AgentRuntimeDefinitionRecord,
  type AgentRuntimeLifecycle as AgentRuntimeLifecycleProtocol,
  type AgentRuntimeStatus,
  type DurableAgentRuntimeParticipant,
  type RuntimeOf,
} from './agentRuntime';

class RuntimeScope {
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private readonly tracked = new Set<Promise<unknown>>();
  private disposed = false;

  register(cleanup: IDisposable | (() => void | Promise<void>)): void {
    const dispose = typeof cleanup === 'function' ? cleanup : () => cleanup.dispose();
    if (this.disposed) {
      void dispose();
      return;
    }
    this.cleanups.push(dispose);
  }

  track<T>(work: Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('Runtime scope is disposed');
    const tracked = work.finally(() => { this.tracked.delete(tracked); });
    this.tracked.add(tracked);
    return tracked;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(this.tracked);
    for (let index = this.cleanups.length - 1; index >= 0; index -= 1) {
      try {
        await this.cleanups[index]!();
      } catch {}
    }
  }
}

interface RuntimeEntry {
  record: AgentRuntimeDefinitionRecord;
  status: AgentRuntimeStatus;
  actor?: AnyActorRef;
  runtime?: unknown;
  listeners?: Set<(state: any) => void>;
  subscription?: { unsubscribe(): void };
  attachment?: IDisposable;
  readonly leases: Set<Promise<unknown>>;
  retiring: boolean;
  retired: boolean;
  drain?: Promise<void>;
  error?: unknown;
  scope?: RuntimeScope;
}

export class AgentRuntimeSet {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly graveyard = new Set<RuntimeEntry>();
  private durableHost: DurableRuntimeParticipantHost | undefined;
  private closed = false;
  private closeDrain: Promise<void> | undefined;

  constructor(
    private readonly agent: AgentContext,
    private readonly accessor: ServicesAccessor,
  ) {}

  apply(record: AgentRuntimeDefinitionRecord): void {
    if (this.closed) return;
    const id = record.definition.id;
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.record === record) return;
      this.entries.delete(id);
      this.graveyard.add(existing);
      this.retireEntry(existing);
    }
    const entry: RuntimeEntry = {
      record,
      status: 'registered',
      leases: new Set(),
      retiring: false,
      retired: false,
    };
    this.entries.set(id, entry);
    if (record.definition.durable !== undefined && this.durableHost !== undefined) {
      this.attachDurableEntry(entry, this.durableHost);
    }
  }

  retireDefinition(record: AgentRuntimeDefinitionRecord): void {
    const id = record.definition.id;
    const entry = this.entries.get(id);
    if (entry === undefined || entry.record !== record) return;
    this.entries.delete(id);
    this.graveyard.add(entry);
    this.retireEntry(entry);
  }

  resolve<Definition extends AgentRuntimeDefinition<any, any>>(
    definition: Definition,
  ): RuntimeOf<Definition> {
    if (this.closed) {
      throw new Error(
        `Agent ${this.agent.agentId}:${String(this.agent.generation)} runtime set is closed`,
      );
    }
    const entry = this.entries.get(definition.id);
    if (entry === undefined || entry.record.definition !== definition || !entry.record.active) {
      throw new Error(`Agent runtime '${definition.id}' is unavailable`);
    }
    return this.runtime(entry) as RuntimeOf<Definition>;
  }

  attachDurable(host: DurableRuntimeParticipantHost): void {
    if (this.closed) return;
    this.durableHost = host;
    for (const entry of this.entries.values()) {
      if (entry.record.definition.durable === undefined) continue;
      this.attachDurableEntry(entry, host);
    }
  }

  inspect(): readonly AgentRuntimeContributionSnapshot[] {
    const out: AgentRuntimeContributionSnapshot[] = [];
    for (const entry of this.entries.values()) out.push(this.line(entry));
    for (const entry of this.graveyard) {
      if (this.entries.has(entry.record.definition.id)) continue;
      out.push(this.line(entry));
    }
    return out;
  }

  close(): Promise<void> {
    if (this.closeDrain !== undefined) return this.closeDrain;
    this.closed = true;
    for (const entry of this.entries.values()) this.retireEntry(entry);
    const drains: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.drain !== undefined) drains.push(entry.drain);
    }
    for (const entry of this.graveyard) {
      if (entry.drain !== undefined) drains.push(entry.drain);
    }
    this.closeDrain = Promise.all(drains).then(() => undefined);
    return this.closeDrain;
  }

  private runtime(entry: RuntimeEntry): unknown {
    if (entry.runtime !== undefined) return entry.runtime;
    this.materialize(entry);
    const definition = entry.record.definition;
    const actor = entry.actor!;
    const listeners = entry.listeners!;
    const scope = new RuntimeScope();
    entry.scope = scope;
    const context: AgentRuntimeContext<any> = {
      agent: this.agent,
      get: (id) => this.accessor.get(id),
      getState: () => {
        if (definition.durable === undefined) {
          throw new BugIndicatingError(`Agent runtime '${definition.id}' has no durable state`);
        }
        return definition.durable.read(actor.getSnapshot());
      },
      dispatch: (event) => this.accessor.get(IEventDispatcher).dispatch(event),
      own: (resource) => scope.register(resource),
      track: (work) => scope.track(this.track(entry, work)),
      onDidChange: (listener) => {
        listeners.add(listener);
        const disposable = toDisposable(() => { listeners.delete(listener); });
        scope.register(disposable);
        return disposable;
      },
    };
    try {
      const runtime = definition.create(context);
      entry.runtime = runtime;
      this.lifecycleOf(runtime)?.start?.();
      return runtime;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      void this.disposeRuntimeResources(entry);
      throw error;
    }
  }

  private materialize(entry: RuntimeEntry): void {
    if (entry.actor !== undefined) return;
    if (this.closed || entry.retiring) {
      throw new Error(`Agent runtime '${entry.record.definition.id}' is unavailable`);
    }
    const definition = entry.record.definition;
    try {
      const actor = createActor(definition.logic, { input: definition.input?.(this.agent) });
      const listeners = new Set<(state: any) => void>();
      entry.actor = actor;
      entry.listeners = listeners;
      let previous: unknown;
      entry.subscription = actor.subscribe({
        next: (snapshot) => {
          if (snapshot.status === 'done') entry.status = 'done';
          if (snapshot.status === 'error') {
            entry.status = 'failed';
            entry.error = snapshot.error;
          }
          if (definition.durable === undefined) return;
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
      previous = definition.durable?.read(actor.getSnapshot());
      if (entry.status === 'registered') entry.status = 'materialized';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      entry.subscription?.unsubscribe();
      entry.actor?.stop();
      entry.subscription = undefined;
      entry.actor = undefined;
      throw error;
    }
  }

  private attachDurableEntry(entry: RuntimeEntry, host: DurableRuntimeParticipantHost): void {
    if (entry.attachment !== undefined) return;
    this.materialize(entry);
    const definition = entry.record.definition;
    const durable = definition.durable!;
    const actor = entry.actor!;
    const participant: DurableAgentRuntimeParticipant = {
      id: definition.id,
      events: durable.events,
      undoable: durable.undoable,
      transition: durable.transition,
      getState: () => durable.read(actor.getSnapshot()),
      commit: (state) => { durable.commit(actor, state); },
    };
    entry.attachment = host.attach(participant);
    if (definition.eager === true) this.runtime(entry);
  }

  private track<T>(entry: RuntimeEntry, work: Promise<T>): Promise<T> {
    if (this.closed || entry.retiring) {
      throw new Error(`Agent runtime '${entry.record.definition.id}' is retiring`);
    }
    const lease = work.finally(() => { entry.leases.delete(lease); });
    entry.leases.add(lease);
    return lease;
  }

  private retireEntry(entry: RuntimeEntry): void {
    if (entry.retiring) return;
    entry.retiring = true;
    entry.drain = entry.leases.size === 0
      ? this.stopEntry(entry)
      : Promise.allSettled(entry.leases).then(() => this.stopEntry(entry));
  }

  private stopEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.retired) return Promise.resolve();
    entry.retired = true;
    entry.status = 'retired';
    return this.disposeRuntimeResources(entry);
  }

  private disposeRuntimeResources(entry: RuntimeEntry): Promise<void> {
    entry.attachment?.dispose();
    entry.attachment = undefined;
    const finish = (): void => {
      entry.subscription?.unsubscribe();
      entry.actor?.stop();
      entry.subscription = undefined;
      entry.actor = undefined;
      entry.runtime = undefined;
      entry.listeners = undefined;
      entry.scope = undefined;
    };
    const disposeScope = (): Promise<void> => {
      const scope = entry.scope;
      if (scope === undefined) {
        finish();
        return Promise.resolve();
      }
      return scope.dispose().then(finish);
    };
    try {
      const disposal = this.lifecycleOf(entry.runtime)?.dispose?.();
      if (disposal instanceof Promise) {
        return disposal.then(disposeScope, (error: unknown) => {
          entry.error = error;
          return disposeScope();
        });
      }
    } catch (error) {
      entry.error = error;
    }
    return disposeScope();
  }

  private lifecycleOf(runtime: unknown): AgentRuntimeLifecycleProtocol | undefined {
    if ((typeof runtime !== 'object' || runtime === null) && typeof runtime !== 'function') {
      return undefined;
    }
    return (runtime as { readonly [AgentRuntimeLifecycle]?: AgentRuntimeLifecycleProtocol })[
      AgentRuntimeLifecycle
    ];
  }

  private line(entry: RuntimeEntry): AgentRuntimeContributionSnapshot {
    return {
      id: entry.record.definition.id,
      generation: entry.record.generation,
      status: entry.status,
      state: entry.actor === undefined ? undefined : this.project(entry.record.definition, entry.actor),
      error: serializeError(entry.error),
    };
  }

  private project(
    definition: AgentRuntimeDefinition<any, any>,
    actor: AnyActorRef,
  ): unknown {
    const snapshot = actor.getSnapshot();
    if (definition.inspect !== undefined) return definition.inspect(snapshot);
    return definition.durable?.read(snapshot);
  }
}

function serializeError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown runtime error';
}
