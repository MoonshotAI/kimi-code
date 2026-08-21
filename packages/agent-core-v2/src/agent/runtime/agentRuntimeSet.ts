import { createActor, type AnyActorRef } from 'xstate';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { BugIndicatingError } from '#/_base/errors/errors';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IEventDispatcher, type DurableRuntimeParticipantHost } from '#/state/eventDispatcher';

import {
  type AgentCapability,
  type AgentRuntimeContext,
  type AgentRuntimeContributionSnapshot,
  type AgentRuntimeDefinition,
  type AgentRuntimeDefinitionRecord,
  type AgentRuntimeStatus,
  type DurableAgentRuntimeParticipant,
} from './agentRuntime';

interface RuntimeEntry {
  record: AgentRuntimeDefinitionRecord;
  status: AgentRuntimeStatus;
  actor?: AnyActorRef;
  facade?: unknown;
  activated: boolean;
  listeners?: Set<(state: any) => void>;
  subscription?: { unsubscribe(): void };
  attachment?: IDisposable;
  readonly leases: Set<Promise<unknown>>;
  retiring: boolean;
  retired: boolean;
  drain?: Promise<void>;
  error?: unknown;
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
    const existing = this.entries.get(record.capability.id);
    if (existing !== undefined) {
      if (existing.record === record) return;
      this.entries.delete(record.capability.id);
      this.graveyard.add(existing);
      this.retireEntry(existing);
    }
    const entry: RuntimeEntry = {
      record,
      status: 'registered',
      activated: false,
      leases: new Set(),
      retiring: false,
      retired: false,
    };
    this.entries.set(record.capability.id, entry);
    if (record.definition.durable !== undefined && this.durableHost !== undefined) {
      this.attachDurableEntry(entry, this.durableHost);
    }
  }

  retireDefinition(record: AgentRuntimeDefinitionRecord): void {
    const entry = this.entries.get(record.capability.id);
    if (entry === undefined || entry.record !== record) return;
    this.entries.delete(record.capability.id);
    this.graveyard.add(entry);
    this.retireEntry(entry);
  }

  resolve<T>(capability: AgentCapability<T>): T {
    if (this.closed) {
      throw new Error(
        `Agent ${this.agent.agentId}:${String(this.agent.generation)} runtime set is closed`,
      );
    }
    const entry = this.entries.get(capability.id);
    if (entry === undefined || !entry.record.active) {
      throw new Error(`Agent runtime '${capability.id}' is unavailable`);
    }
    return this.facade(entry) as T;
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
      if (this.entries.has(entry.record.capability.id)) continue;
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

  private facade(entry: RuntimeEntry): unknown {
    if (entry.facade !== undefined) return entry.facade;
    this.materialize(entry);
    const definition = entry.record.definition;
    const actor = entry.actor!;
    const listeners = entry.listeners!;
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
      track: (work) => this.track(entry, work),
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
      return entry.facade;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      this.disposeRuntimeResources(entry);
      throw error;
    }
  }

  private materialize(entry: RuntimeEntry): void {
    if (entry.actor !== undefined) return;
    if (this.closed || entry.retiring) {
      throw new Error(`Agent runtime '${entry.record.capability.id}' is unavailable`);
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
    if (definition.eager === true) this.facade(entry);
  }

  private track<T>(entry: RuntimeEntry, work: Promise<T>): Promise<T> {
    if (this.closed || entry.retiring) {
      throw new Error(`Agent runtime '${entry.record.capability.id}' is retiring`);
    }
    const lease = work.finally(() => { entry.leases.delete(lease); });
    entry.leases.add(lease);
    return lease;
  }

  private retireEntry(entry: RuntimeEntry): void {
    if (entry.retiring) return;
    entry.retiring = true;
    if (entry.leases.size === 0) {
      this.stopEntry(entry);
      return;
    }
    entry.drain = Promise.allSettled(entry.leases).then(() => { this.stopEntry(entry); });
  }

  private stopEntry(entry: RuntimeEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    this.disposeRuntimeResources(entry);
    entry.status = 'retired';
  }

  private disposeRuntimeResources(entry: RuntimeEntry): void {
    entry.attachment?.dispose();
    entry.attachment = undefined;
    entry.subscription?.unsubscribe();
    entry.actor?.stop();
    entry.subscription = undefined;
    entry.actor = undefined;
    entry.facade = undefined;
    entry.listeners = undefined;
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
