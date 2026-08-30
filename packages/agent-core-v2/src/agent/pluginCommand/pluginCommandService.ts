import { randomUUID } from 'node:crypto';

import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { expandCommandArguments } from '#/app/plugin/commands';
import { IPluginService } from '#/app/plugin/plugin';
import { AgentPrompt, type PromptRuntime } from '#/actor/prompt/promptAgentRuntime';
import { promptMetadataTextFromText } from '#/actor/prompt/promptMetadataText';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import {
  IAgentPluginCommandService,
  PluginCommandActivated,
  type ActivatePluginCommandPayload,
} from './pluginCommand';

export class AgentPluginCommandService implements IAgentPluginCommandService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    private readonly scopeContext: IAgentScopeContext,
  ) { }

  private prompt(): PromptRuntime {
    return this.agentLifecycle.resolve(this.scopeContext.agentContext, AgentPrompt);
  }

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
    await this.dispatcher.dispatch(
      new PluginCommandActivated({
        agentId: this.scopeContext.agentId,
        activationId: origin.activationId,
        pluginId: origin.pluginId,
        commandName: origin.commandName,
        commandArgs: origin.commandArgs,
        trigger: origin.trigger,
      }),
    );
    await this.prompt().enqueue({ message: {
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

