/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

export type InterruptionReminderState = null;

const interruptionReminderRecordedSchema = z.object({
  agentId: z.string(),
  turnId: z.number().int().nonnegative(),
});

export class InterruptionReminderRecorded extends AgentEvent2<
  z.infer<typeof interruptionReminderRecordedSchema>
> {
  static override readonly type = 'interruptionReminder.recorded';
  static override readonly durable = true;
  static override readonly schema = interruptionReminderRecordedSchema;
}
export interface InterruptionReminderRecorded {
  readonly agentId: string;
  readonly turnId: number;
}

export const interruptionReminderKey = defineState(
  'interruptionReminder',
  (): InterruptionReminderState => null,
)
  .replayable({ schema: z.custom<InterruptionReminderState>() })
  .on(InterruptionReminderRecorded, () => {});
