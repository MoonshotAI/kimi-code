/**
 * `agentPlugin` domain — Agent-scope plugin integration contract.
 *
 * Bridges App-scope plugin declarations into the main agent's runtime context.
 * Bound at Agent scope and instantiated only for the main agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentPluginService {
  readonly _serviceBrand: undefined;

  refreshSessionStart(): Promise<void>;
}

export const IAgentPluginService: ServiceIdentifier<IAgentPluginService> =
  createDecorator<IAgentPluginService>('agentPluginService');
