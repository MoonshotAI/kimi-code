/**
 * `interruptionReminder` domain (L4) — persists and restores pending
 * user-interruption reminders.
 *
 * Projects the `loop` domain's `turn.cancel` fact into the set of turns whose
 * interruption reminder still has to reach the conversation, and owns the op
 * that records a reminder's delivery. Consumed by the Agent-scope
 * `interruptionReminderService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export const InterruptionReminderModel = defineModel<readonly number[]>(
  'interruptionReminder',
  () => [],
  {
    reducers: {
      'turn.cancel': (state, { turnId, target, reason }) => {
        if (target !== 'active' || reason !== 'user_cancelled' || turnId === undefined) {
          return state;
        }
        if (state.includes(turnId)) return state;
        return [...state, turnId].toSorted((a, b) => a - b);
      },
    },
  },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'interruptionReminder.recorded': typeof interruptionReminderRecorded;
  }
}

export const interruptionReminderRecorded = InterruptionReminderModel.defineOp(
  'interruptionReminder.recorded',
  {
    schema: z.object({ turnId: z.number().int().nonnegative() }),
    apply: (state, { turnId }) => state.filter((pendingTurnId) => pendingTurnId !== turnId),
  },
);
