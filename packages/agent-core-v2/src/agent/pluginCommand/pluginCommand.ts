/**
 * `pluginCommand` domain — Agent-scoped plugin command activation contract.
 *
 * `IAgentPluginCommandService.activate` drives a user-slash plugin command
 * into the agent's prompt pipeline: the command definition lives in the
 * App-scope `plugin` domain, while activation (argument expansion, the
 * `plugin_command.activated` domain event, prompt enqueue) must run inside the
 * agent scope. Bound at Agent scope.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';

export interface ActivatePluginCommandPayload {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface PluginCommandActivatedPayload {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export class PluginCommandActivated extends Event2<PluginCommandActivatedPayload> {
  static override readonly type = 'plugin_command.activated';
  static override readonly observable = true;
}
export interface PluginCommandActivated extends PluginCommandActivatedPayload {}

export interface IAgentPluginCommandService {
  readonly _serviceBrand: undefined;

  activate(payload: ActivatePluginCommandPayload): Promise<void>;
}

export const IAgentPluginCommandService: ServiceIdentifier<IAgentPluginCommandService> =
  createDecorator<IAgentPluginCommandService>('agentPluginCommandService');
