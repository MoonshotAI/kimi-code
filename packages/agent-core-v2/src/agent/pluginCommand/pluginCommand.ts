/**
 * `pluginCommand` domain — Agent-scoped plugin command activation contract.
 *
 * `IAgentPluginCommandService.activate` drives a user-slash plugin command
 * into the agent's prompt pipeline: the command definition lives in the
 * App-scope `plugin` domain, while activation (argument expansion, the
 * `plugin_command.activated` domain event, prompt enqueue) must run inside the
 * agent scope. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ActivatePluginCommandPayload {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface PluginCommandActivatedEvent {
  readonly type: 'plugin_command.activated';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'plugin_command.activated': PluginCommandActivatedEvent;
  }
}

export interface IAgentPluginCommandService {
  readonly _serviceBrand: undefined;

  activate(payload: ActivatePluginCommandPayload): Promise<void>;
}

export const IAgentPluginCommandService: ServiceIdentifier<IAgentPluginCommandService> =
  createDecorator<IAgentPluginCommandService>('agentPluginCommandService');
