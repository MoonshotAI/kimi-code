/**
 * `agentProfileCatalog` domain — `IAgentProfileRegistry` contract.
 *
 * The Registry of the Contribution / Registry / Catalog extension-point
 * pattern for agent profiles. A contribution is a plain data structure
 * (`AgentProfileContribution`) offered by a loader; the registry stores at
 * most one contribution per (`sourceId`, `workspaceKey`) pair — re-registering
 * replaces the previous entry, which is the only dedup this layer performs.
 * Name-level dedup, priority ordering, and the builtin-override rule are the
 * Catalog's projection job (`ISessionAgentProfileCatalog`), never the
 * registry's.
 *
 * Bound at App scope so contributors from ANY scope can register: App loaders
 * (builtin / plugin / user) register global contributions (`workspaceKey`
 * absent), while each Workspace-scope loader registers its workspace-local
 * contribution tagged with the handler's `workspaceKey`, and multiple
 * workspaces never collide. `register` returns a handle whose `dispose`
 * unregisters — but only the entry it registered, so a stale handle can never
 * evict a newer re-registration. Every mutation fires `onDidChange` with the
 * affected (sourceId, workspaceKey) so session catalogs can re-project.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { AgentProfileContribution } from './agentProfileContribution';

export interface AgentProfileRegistration {
  readonly sourceId: string;
  readonly priority: number;
  readonly workspaceKey?: string;
  readonly contribution: AgentProfileContribution;
}

export interface AgentProfileRegistryChange {
  readonly sourceId: string;
  readonly workspaceKey?: string;
}

export interface RegisterAgentProfileOptions {
  readonly priority?: number;
  readonly workspaceKey?: string;
}

export interface IAgentProfileRegistry {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<AgentProfileRegistryChange>;

  register(
    sourceId: string,
    contribution: AgentProfileContribution,
    options?: RegisterAgentProfileOptions,
  ): IDisposable;

  unregister(sourceId: string, workspaceKey?: string): void;

  entries(): readonly AgentProfileRegistration[];
}

export const IAgentProfileRegistry: ServiceIdentifier<IAgentProfileRegistry> =
  createDecorator<IAgentProfileRegistry>('agentProfileRegistry');
