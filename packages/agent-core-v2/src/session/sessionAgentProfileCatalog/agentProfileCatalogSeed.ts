/**
 * `sessionAgentProfileCatalog` domain (L3) — seeded workspace-key contract.
 *
 * Defines `ISessionAgentProfileCatalogSeed`, the pure-data injection contract
 * the Workspace handler hands to every Session scope it creates: ONLY the
 * handler's `workspaceId`. The Session-scope `ISessionAgentProfileCatalog`
 * uses it to pick this workspace's tagged contributions out of the App-scope
 * `IAgentProfileRegistry` (global entries plus the ones registered with this
 * key) — the catalog reads the registry directly, so no per-workspace merged
 * view is seeded anymore. The key travels as a seed (rather than being
 * recomputed from the session's workDir) because the handler's id may be
 * folded from an alias spelling of the root. Seeded into the Session scope by
 * `sessionLifecycle` when the session is materialized. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionAgentProfileCatalogSeed {
  readonly _serviceBrand: undefined;

  readonly workspaceKey: string;
}

export const ISessionAgentProfileCatalogSeed: ServiceIdentifier<ISessionAgentProfileCatalogSeed> =
  createDecorator<ISessionAgentProfileCatalogSeed>('sessionAgentProfileCatalogSeed');

export function sessionAgentProfileCatalogSeed(
  seed: ISessionAgentProfileCatalogSeed,
): ScopeSeed {
  return [[ISessionAgentProfileCatalogSeed as ServiceIdentifier<unknown>, seed]];
}
