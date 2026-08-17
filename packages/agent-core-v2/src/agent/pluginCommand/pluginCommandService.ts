/**
 * `pluginCommand` domain — `IAgentPluginCommandService` implementation.
 *
 * Resolves the command definition through `plugin` (`IPluginService`), expands
 * its arguments, publishes the `plugin_command.activated` domain event through
 * `eventBus`, enqueues the expanded body as a user message through `prompt`,
 * and — for the main agent only — persists the derived title/lastPrompt
 * through `sessionMetadata`, publishing the live update through `event`.
 * Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { expandCommandArguments } from '#/app/plugin/commands';
import { IPluginService } from '#/app/plugin/plugin';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromText } from '#/agent/prompt/promptMetadataText';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

import {
  IAgentPluginCommandService,
  type ActivatePluginCommandPayload,
} from './pluginCommand';

export class AgentPluginCommandService implements IAgentPluginCommandService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IEventBus private readonly eventBus: IEventBus,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) { }

  async activate(payload: ActivatePluginCommandPayload): Promise<void> {
    const commands = await this.plugins.listPluginCommands();
    const def = commands.find(
      (command) => command.pluginId === payload.pluginId && command.name === payload.commandName,
    );
    if (def === undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Plugin command "${payload.pluginId}:${payload.commandName}" was not found`,
      );
    }
    const commandArgs = payload.args ?? '';
    const expanded = expandCommandArguments(def.body, commandArgs);
    const origin = {
      kind: 'plugin_command' as const,
      activationId: randomUUID(),
      pluginId: payload.pluginId,
      commandName: payload.commandName,
      commandArgs: payload.args,
      trigger: 'user-slash' as const,
    };
    this.eventBus.publish({
      type: 'plugin_command.activated',
      activationId: origin.activationId,
      pluginId: origin.pluginId,
      commandName: origin.commandName,
      commandArgs: origin.commandArgs,
      trigger: origin.trigger,
    });
    await this.promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: expanded }],
      toolCalls: [],
      origin,
    } });
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromPluginCommand(payload),
      );
    }
  }
}

function promptMetadataTextFromPluginCommand(
  payload: ActivatePluginCommandPayload,
): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return promptMetadataTextFromText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPluginCommandService,
  AgentPluginCommandService,
  ScopeActivation.OnScopeCreated,
  'pluginCommand',
);
