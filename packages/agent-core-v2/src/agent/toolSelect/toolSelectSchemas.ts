/**
 * `toolSelect` domain — `IAgentToolSelectSchemasService` contract.
 *
 * Defines the Agent-scope marker service that declares pending dynamic-tool
 * schemas into the history through the `contextInjector` boundary scheduler.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentToolSelectSchemasService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolSelectSchemasService: ServiceIdentifier<IAgentToolSelectSchemasService> =
  createDecorator<IAgentToolSelectSchemasService>('agentToolSelectSchemasService');
