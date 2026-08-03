/**
 * `media` domain — media-tools registrar contract.
 *
 * Identifier-only module, so consumers that need the service identifier do
 * not pull the implementation's scoped registration into their module graph.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentMediaToolsRegistrar {
  readonly _serviceBrand: undefined;
}

export const IAgentMediaToolsRegistrar: ServiceIdentifier<IAgentMediaToolsRegistrar> =
  createDecorator<IAgentMediaToolsRegistrar>('agentMediaToolsRegistrar');
