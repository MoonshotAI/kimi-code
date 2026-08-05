/**
 * `systemReminder` domain — low-level model-facing reminder write contract.
 *
 * Defines the Agent-scoped write head used by context injection, the durable
 * world-event queue, and prompt-owned media annotations. Bound at Agent scope.
 */

import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
