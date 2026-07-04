import { createDecorator } from "#/_base/di";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';

export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  /**
   * Append a `<system-reminder>` message to the end of the context memory.
   * Returns the created message.
   */
  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
  /**
   * Remove the last context message if it passes the supplied filter.
   * Returns `true` when a message was removed.
   */
  removeLastReminder(filter: (message: ContextMessage) => boolean): boolean;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
