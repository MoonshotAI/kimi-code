import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';

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

  removeLastReminder(filter: (message: ContextMessage) => boolean): boolean {
    const history = this.context.get();
    const lastIndex = history.length - 1;
    const last = history[lastIndex];
    if (last === undefined || !filter(last)) {
      return false;
    }
    this.context.splice(lastIndex, 1, []);
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSystemReminderService,
  AgentSystemReminderService,
  InstantiationType.Delayed,
  'systemReminder',
);
