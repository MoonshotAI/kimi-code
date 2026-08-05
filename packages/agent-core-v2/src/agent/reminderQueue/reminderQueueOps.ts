/**
 * `reminderQueue` domain — wire Model (`ReminderQueueModel`) and the persisted
 * Ops backing the exactly-once delivery ledger.
 *
 * State is the FIFO list of pending once-reminders. `reminderQueue.enqueue`
 * appends a pending entry; `reminderQueue.delivered` clears it once the
 * reminder has been appended to the conversation. Both Ops persist, so replay
 * rebuilds the pending set and a crash anywhere between enqueue and delivery
 * is reconciled by the next restore drain. The Model is a plain `defineModel`
 * — deliberately NOT checkpointed — so `context.undo` never revives a
 * delivered entry: a once-reminder's delivery is a world fact, not branch
 * state.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface ReminderQueueEntry {
  readonly id: string;
  readonly variant: string;
  readonly content: string;
  readonly ownerPromptId?: string;
}

const reminderQueueEntrySchema = z.object({
  id: z.string().min(1),
  variant: z.string().min(1),
  content: z.string(),
  ownerPromptId: z.string().optional(),
});

export const ReminderQueueModel = defineModel<readonly ReminderQueueEntry[]>(
  'reminderQueue',
  () => [],
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'reminderQueue.enqueue': typeof reminderQueueEnqueue;
    'reminderQueue.delivered': typeof reminderQueueDelivered;
  }
}

export const reminderQueueEnqueue = ReminderQueueModel.defineOp('reminderQueue.enqueue', {
  schema: z.object({ entry: reminderQueueEntrySchema }),
  apply: (state, { entry }) => [...state, entry],
});

export const reminderQueueDelivered = ReminderQueueModel.defineOp('reminderQueue.delivered', {
  schema: z.object({ id: z.string().min(1) }),
  apply: (state, { id }) => state.filter((entry) => entry.id !== id),
});
