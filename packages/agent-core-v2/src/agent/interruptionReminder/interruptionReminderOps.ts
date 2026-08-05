/**
 * `interruptionReminder` domain — checkpointed wire Model for user-cancelled
 * interruption reminders.
 *
 * Projects the durable `turn.cancel` fact into pending model-facing state,
 * follows conversation undo through `contextMemory`'s checkpoint protocol, and
 * clears the pending state when the injection is appended. Bound at Agent scope.
 */

import { z } from 'zod';

import {
  defineCheckpointedModel,
  type Checkpointed,
} from '#/agent/contextMemory/conversationTime';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

export const INTERRUPTION_REMINDER = [
  'The previous turn was interrupted by the user before completion;',
  'any partial output shown above is incomplete.',
  "The user's next message continues the conversation.",
].join(' ');

export type InterruptionReminderState = Checkpointed<readonly number[]>;

export const InterruptionReminderModel = defineCheckpointedModel<readonly number[]>(
  'interruptionReminder',
  () => [],
  {
    onAppendMessage: (current, message) =>
      message.origin?.kind === 'injection' &&
      message.origin.variant === INTERRUPTION_REMINDER_VARIANT &&
      current.length > 0
        ? []
        : current,
    reducers: {
      'turn.cancel': (state, { turnId, target, reason }) => {
        if (
          turnId === undefined ||
          target !== 'active' ||
          reason !== 'user_cancelled' ||
          state.current.includes(turnId)
        ) {
          return state;
        }
        return { ...state, current: [...state.current, turnId] };
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
    apply: (state, { turnId }) => ({
      ...state,
      current: state.current.filter((pendingTurnId) => pendingTurnId !== turnId),
    }),
  },
);
