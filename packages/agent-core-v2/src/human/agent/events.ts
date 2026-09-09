import { z } from 'zod';

import { defineEvent } from '#/eventStore/events';

import { historyMessageSchema, systemMessageSchema, userMessageSchema } from './historySchema';

export const messageAppended = defineEvent({
  type: 'message.appended',
  schema: z.object({ message: historyMessageSchema }),
});
export type MessageAppended = ReturnType<typeof messageAppended>;

export const turnStarted = defineEvent({
  type: 'turn.started',
  schema: z.object({ turnId: z.number().int(), queueItemId: z.string().optional() }),
});
export type TurnStarted = ReturnType<typeof turnStarted>;

export const turnEnded = defineEvent({
  type: 'turn.ended',
  schema: z.object({
    turnId: z.number().int(),
    outcome: z.enum(['done', 'failed', 'aborted']),
    errorMessage: z.string().optional(),
  }),
});
export type TurnEnded = ReturnType<typeof turnEnded>;

export const inputSubmitted = defineEvent({
  type: 'input.submitted',
  schema: z.object({ id: z.string().optional(), message: userMessageSchema }),
});
export type InputSubmitted = ReturnType<typeof inputSubmitted>;

export const inputNotified = defineEvent({
  type: 'input.notified',
  schema: z.object({ message: userMessageSchema, source: z.string().optional() }),
});
export type InputNotified = ReturnType<typeof inputNotified>;

export const inputReminded = defineEvent({
  type: 'input.reminded',
  schema: z.object({ key: z.string(), message: z.union([userMessageSchema, systemMessageSchema]) }),
});
export type InputReminded = ReturnType<typeof inputReminded>;

export const inputSteered = defineEvent({
  type: 'input.steered',
  schema: z.object({ id: z.string(), message: userMessageSchema }),
});
export type InputSteered = ReturnType<typeof inputSteered>;

export const inputCancelled = defineEvent({
  type: 'input.cancelled',
  schema: z.object({ id: z.string() }),
});
export type InputCancelled = ReturnType<typeof inputCancelled>;

export const queueDrained = defineEvent({
  type: 'queue.drained',
  schema: z.object({ id: z.string().optional() }),
});
export type QueueDrained = ReturnType<typeof queueDrained>;

export const inputDrained = defineEvent({ type: 'input.drained', schema: z.object({}) });
export type InputDrained = ReturnType<typeof inputDrained>;

export const notificationsDrained = defineEvent({ type: 'notifications.drained', schema: z.object({}) });
export type NotificationsDrained = ReturnType<typeof notificationsDrained>;

export const stateUpdated = defineEvent({
  type: 'state.updated',
  schema: z.object({ name: z.string(), value: z.unknown() }),
});
export type StateUpdated = ReturnType<typeof stateUpdated>;
