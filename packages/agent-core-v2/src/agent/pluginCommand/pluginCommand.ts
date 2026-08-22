/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { AgentEvent2 } from '#/app/event/event2';

export interface ActivatePluginCommandPayload {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface PluginCommandActivatedPayload {
  readonly agentId: string;
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export class PluginCommandActivated extends AgentEvent2<PluginCommandActivatedPayload> {
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
