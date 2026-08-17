/**
 * `interruptionReminder` domain — legacy journal compatibility tombstone.
 *
 * Retains the historical `interruptionReminder.recorded` durable event as a
 * no-op fold on a `null` state so old Agent journals replay without
 * unknown-record diagnostics. New interruption reminders append at the
 * cancellation event point and write no domain-owned delivery state.
 * Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

export type InterruptionReminderState = null;

const interruptionReminderRecordedSchema = z.object({
  turnId: z.number().int().nonnegative(),
});

export class InterruptionReminderRecorded extends Event2<
  z.infer<typeof interruptionReminderRecordedSchema>
> {
  static override readonly type = 'interruptionReminder.recorded';
  static override readonly durable = true;
  static override readonly schema = interruptionReminderRecordedSchema;
}
export interface InterruptionReminderRecorded
  extends z.infer<typeof interruptionReminderRecordedSchema> {}

export const interruptionReminderKey = defineState(
  'interruptionReminder',
  (): InterruptionReminderState => null,
)
  .replayable({ schema: z.custom<InterruptionReminderState>() })
  .on(InterruptionReminderRecorded, () => {});
