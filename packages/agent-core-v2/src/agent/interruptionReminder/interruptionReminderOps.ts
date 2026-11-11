/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

export interface InterruptionReminderPending {
  readonly turnId: number;
  readonly ownerPromptId?: string;
}

export interface InterruptionReminderState {
  readonly pending: InterruptionReminderPending | undefined;
  readonly consumedTurnIds: readonly number[];
}

const interruptionCancellationRequestedSchema = z.object({
  agentId: z.string(),
  turnId: z.number().int().nonnegative(),
  ownerPromptId: z.string().optional(),
});

export class InterruptionCancellationRequested extends AgentEvent2<
  z.infer<typeof interruptionCancellationRequestedSchema>
> {
  static override readonly type = 'interruptionReminder.requested';
  static override readonly durable = true;
  static override readonly schema = interruptionCancellationRequestedSchema;
}
export interface InterruptionCancellationRequested {
  readonly agentId: string;
  readonly turnId: number;
  readonly ownerPromptId?: string;
}

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
  (): InterruptionReminderState => ({ pending: undefined, consumedTurnIds: [] }),
)
  .replayable({ schema: z.custom<InterruptionReminderState>() })
  .undoable()
  .on(InterruptionCancellationRequested, (s, e) => {
    if (s.consumedTurnIds.includes(e.turnId)) return s;
    return { ...s, pending: { turnId: e.turnId, ownerPromptId: e.ownerPromptId } };
  })
  .on(InterruptionReminderRecorded, (s, e) => {
    if (s.consumedTurnIds.includes(e.turnId)) return s;
    return {
      pending: s.pending?.turnId === e.turnId ? undefined : s.pending,
      consumedTurnIds: [...s.consumedTurnIds, e.turnId],
    };
  });
