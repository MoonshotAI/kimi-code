/**
 * `reminderQueue` domain — world-event exactly-once reminder contract.
 *
 * Persists and drains reminders whose delivery is a durable fact rather than
 * conversation state. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface OnceReminderInput {
  readonly variant: string;
  readonly content: string;
}

export interface IAgentReminderQueueService {
  readonly _serviceBrand: undefined;

  enqueue(input: OnceReminderInput): string;

  drain(): void;
}

export const IAgentReminderQueueService = createDecorator<IAgentReminderQueueService>(
  'agentReminderQueueService',
);
