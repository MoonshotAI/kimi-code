import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  /**
   * Append a `<system-reminder>` message to the end of the context memory.
   * Returns the created message.
   */
  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
