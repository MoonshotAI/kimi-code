import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { AgentProfileViewer } from '#/app/agentProfileCatalog/agentProfileRegistry';

export interface ISessionAgentProfileCatalogSeed extends AgentProfileViewer {
  readonly _serviceBrand: undefined;
}

export const ISessionAgentProfileCatalogSeed: ServiceIdentifier<ISessionAgentProfileCatalogSeed> =
  createDecorator<ISessionAgentProfileCatalogSeed>('sessionAgentProfileCatalogSeed');

export function sessionAgentProfileCatalogSeed(
  seed: ISessionAgentProfileCatalogSeed,
): ScopeSeed {
  return [[ISessionAgentProfileCatalogSeed as ServiceIdentifier<unknown>, seed]];
}
