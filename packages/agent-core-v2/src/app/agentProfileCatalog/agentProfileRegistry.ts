/**
 * `agentProfileCatalog` domain — `IAgentProfileRegistry` contract.
 *
 * The Registry of the Contribution / Registry / Catalog extension-point
 * pattern for agent profiles, surfaced as a fold over the
 * `AgentProfileContribution` collection (D12): loaders contribute records
 * with `this.provide(AgentProfileContribution, …)` — there is no register
 * API — and the App-scope fold projects the live collection view into this
 * read surface. The fold keeps at most one contribution per (`sourceId`,
 * `workspaceKey`) pair — a later record for the same pair shadows the
 * earlier one, the old re-register-replaces semantics — which is the only
 * dedup this layer performs. Name-level dedup, priority ordering, and the
 * builtin-override rule are the Catalog's projection job
 * (`ISessionAgentProfileCatalog`), never the registry's.
 *
 * Bound at App scope so records from ANY scope land in the projection: App
 * loaders (builtin) contribute global records (`workspaceKey` absent), while
 * each Workspace-scope loader contributes its workspace-local record tagged
 * with the handler's `workspaceKey`, and multiple workspaces never collide.
 * A record dies with its providing unit — a reload replaces it, a dead
 * workspace handler withdraws its records — and withdrawing a shadowed
 * record stays silent: a stale contribution can never evict the current
 * one. Every projection change fires `onDidChange` with the affected
 * (sourceId, workspaceKey) so session catalogs can re-project.
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

export interface IAgentProfileRegistry {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<AgentProfileRegistryChange>;

  entries(): readonly AgentProfileRegistration[];
  register(registration: AgentProfileRegistration): IDisposable;
}

export const IAgentProfileRegistry: ServiceIdentifier<IAgentProfileRegistry> =
  createDecorator<IAgentProfileRegistry>('agentProfileRegistry');
