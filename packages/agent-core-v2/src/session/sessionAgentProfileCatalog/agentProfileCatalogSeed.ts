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
