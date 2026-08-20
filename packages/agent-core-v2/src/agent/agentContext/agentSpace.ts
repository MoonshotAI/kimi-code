import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { StateKey } from '#/_base/state/stateRegistry';
import type { Event2 } from '#/app/event/event2';
import {
  type AgentModel,
  type AgentModelBridge,
  type AgentModelDefinition,
} from '#/state/agentModel';

import type { AgentContext } from './agentContext';

export type AgentModelInstanceOf<D> = D extends AgentModelDefinition<any, infer M> ? M : never;

/**
 * Per-agent store of materialized domain Model instances, minted by the
 * agent lifecycle together with the `AgentContext`. `use` runs `run` against
 * the definition's instance under a lease: synchronous when `run` is
 * synchronous, otherwise the lease extends until the returned promise
 * settles. Stale (disposed) spaces reject every call; contexts not issued by
 * the lifecycle carry no space at all.
 */
export interface AgentSpace {
  use<D extends AgentModelDefinition<any, any>, R>(
    definition: D,
    run: (model: AgentModelInstanceOf<D>) => R,
  ): R;
}

export interface AgentSpaceHost {
  isActiveModelDefinition(definition: AgentModelDefinition<any, any>): boolean;
  registerModel(definition: AgentModelDefinition<any, any>, model: AgentModel<any>): void;
  dispatchModelEvent(event: Event2<any>): Promise<void>;
  readLegacyState(key: StateKey<any>): unknown;
}

interface ModelEntry {
  readonly definition: AgentModelDefinition<any, any>;
  readonly model: AgentModel<any>;
  leases: number;
  retired: boolean;
  disposed: boolean;
}

export class AgentSpaceImpl implements AgentSpace {
  private readonly instances = new Map<AgentModelDefinition<any, any>, ModelEntry>();
  private host: AgentSpaceHost | undefined;
  private context: AgentContext | undefined;
  private dead = false;

  constructor(private readonly agentId: string) {}

  _bindContext(context: AgentContext): void {
    this.context = context;
  }

  _attachHost(host: AgentSpaceHost): void {
    this.host = host;
  }

  _detachHost(host: AgentSpaceHost): void {
    if (this.host === host) this.host = undefined;
  }

  use<D extends AgentModelDefinition<any, any>, R>(
    definition: D,
    run: (model: AgentModelInstanceOf<D>) => R,
  ): R {
    const entry = this.ensureModel(definition);
    entry.leases += 1;
    let result: R;
    try {
      result = run(entry.model as AgentModelInstanceOf<D>);
    } catch (error) {
      this.release(entry);
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(() => {
        this.release(entry);
      }) as R;
    }
    this.release(entry);
    return result;
  }

  ensureModel(definition: AgentModelDefinition<any, any>): ModelEntry {
    const existing = this.instances.get(definition);
    if (existing !== undefined) return existing;
    if (this.dead) {
      throw new Error(`Agent ${this.agentId} space is disposed`);
    }
    const host = this.host;
    if (host === undefined) {
      throw new BugIndicatingError(`Agent ${this.agentId} space has no model host`);
    }
    if (!host.isActiveModelDefinition(definition)) {
      throw new Error(`Model definition '${definition.id}' is unavailable`);
    }
    const context = this.context;
    if (context === undefined) {
      throw new BugIndicatingError(`Agent ${this.agentId} space is not bound to a context`);
    }
    const bridge: AgentModelBridge = {
      dispatch: (event) => host.dispatchModelEvent(event),
      readLegacy: (key) => host.readLegacyState(key),
      initialState: () => Object.freeze(definition.state.initial()),
    };
    const model = new definition.model({ agent: context, bridge });
    model._seal();
    validateApplierCoverage(definition, model);
    const entry: ModelEntry = { definition, model, leases: 0, retired: false, disposed: false };
    this.instances.set(definition, entry);
    host.registerModel(definition, model);
    return entry;
  }

  retireModel(definition: AgentModelDefinition<any, any>): void {
    const entry = this.instances.get(definition);
    if (entry === undefined) return;
    this.instances.delete(definition);
    entry.retired = true;
    if (entry.leases === 0) this.disposeEntry(entry);
  }

  _kill(): void {
    if (this.dead) return;
    this.dead = true;
    const entries = [...this.instances.values()];
    this.instances.clear();
    for (const entry of entries) {
      entry.retired = true;
      if (entry.leases === 0) this.disposeEntry(entry);
    }
  }

  private release(entry: ModelEntry): void {
    entry.leases -= 1;
    if (entry.leases === 0 && entry.retired) this.disposeEntry(entry);
  }

  private disposeEntry(entry: ModelEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      const result = entry.model.dispose();
      if (result instanceof Promise) {
        result.catch((error: unknown) => onUnexpectedError(error));
      }
    } catch (error) {
      onUnexpectedError(error);
    }
  }
}

function validateApplierCoverage(
  definition: AgentModelDefinition<any, any>,
  model: AgentModel<any>,
): void {
  const registered = model._appliersTable();
  for (const cls of definition.events) {
    if (!registered.has(cls)) {
      throw new BugIndicatingError(
        `Agent model '${definition.id}' does not apply declared event '${cls.type}'`,
      );
    }
  }
  for (const cls of registered.keys()) {
    if (!definition.events.includes(cls)) {
      throw new BugIndicatingError(
        `Agent model '${definition.id}' applies undeclared event '${cls.type}'`,
      );
    }
  }
}

export function agentSpaceOf(agent: AgentContext): AgentSpace {
  const space = (agent as { readonly space?: AgentSpace }).space;
  if (space === undefined) {
    throw new Error(
      `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
    );
  }
  return space;
}
