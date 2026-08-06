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

export interface OnceReminderDisclosure {
  readonly kind: 'once_reminder';
  readonly id: string;
}

export function isOnceReminderDisclosure(value: unknown): value is OnceReminderDisclosure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown };
  return candidate.kind === 'once_reminder' && typeof candidate.id === 'string';
}

export interface IAgentReminderQueueService {
  readonly _serviceBrand: undefined;

  enqueue(input: OnceReminderInput): void;

  drain(): void;
}

export const IAgentReminderQueueService = createDecorator<IAgentReminderQueueService>(
  'agentReminderQueueService',
);
