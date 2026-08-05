/**
 * `systemReminder` domain — `IAgentSystemReminderService` implementation.
 *
 * Appends model-facing reminder messages, wrapped by `wrapSystemReminder`,
 * into the conversation through `contextMemory`. Bound at Agent scope.
 */

import { Disposable } from "#/_base/di/lifecycle";
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

import { IAgentSystemReminderService, wrapSystemReminder } from './systemReminder';

export class AgentSystemReminderService extends Disposable implements IAgentSystemReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
  }

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage {
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: wrapSystemReminder(content),
        },
      ],
      toolCalls: [],
      origin,
    };
    this.context.append(message);
    return message;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSystemReminderService,
  AgentSystemReminderService,
  ScopeActivation.OnScopeCreated,
  'systemReminder',
);
