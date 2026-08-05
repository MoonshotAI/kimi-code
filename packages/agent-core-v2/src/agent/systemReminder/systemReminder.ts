import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

/**
 * The unified reminder write head — wraps content into a `<system-reminder>`
 * message and appends it to the conversation. This is a low-level INTERNAL
 * API: domain code must not call it directly. Past-tense events go through
 * `IAgentReminderQueueService.enqueue` (exactly-once); present-tense state
 * goes through `IAgentContextInjectorService.register` (reconciled). The only
 * legitimate callers are those two scheduler components.
 */
export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
