/**
 * `interruptionReminder` domain — legacy wire compatibility tombstone.
 *
 * Retains the historical `interruptionReminder.recorded` Op as a no-op so old
 * Agent journals replay without unknown-record diagnostics. New interruption
 * reminders append at the cancellation event point and write no domain-owned
 * delivery state. Scope-agnostic.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

export type InterruptionReminderState = null;

export const InterruptionReminderModel = defineModel<InterruptionReminderState>(
  'interruptionReminder',
  () => null,
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
    apply: (state) => state,
  },
);
