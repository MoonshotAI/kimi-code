/**
 * `sessionAgentProfileCatalog` domain — seeded workspace-key contract.
 *
 * Defines `ISessionAgentProfileCatalogSeed`, the pure-data injection contract
 * carrying ONLY the workspace handler's `workspaceId`. The key travels as a
 * seed (rather than being recomputed from the session's workDir) because the
 * handler's id may be folded from an alias spelling of the root.
 * Session-scoped.
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
