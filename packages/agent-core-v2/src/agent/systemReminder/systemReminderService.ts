import { Disposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

import { IAgentSystemReminderService } from './systemReminder';

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
          text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
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
  InstantiationType.Eager,
  'systemReminder',
);
