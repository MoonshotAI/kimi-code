/**
 * `loop` domain (L4) — user-interruption reminder aspect.
 *
 * A turn the user deliberately cancelled (Esc) would otherwise leave no mark
 * the model can see: the next user prompt lands as an ordinary message right
 * after the interrupted turn's residue, with nothing saying the previous turn
 * was cut off on purpose. This service watches `turn.ended` and appends a
 * durable `<system-reminder>` (`origin: { kind: 'injection', variant:
 * 'interruption' }`) at the context tail — after the interrupted turn's
 * residue, before the next user message — so the marker persists to the wire,
 * replays on resume, and stays hidden from transcripts, all through the
 * existing injection machinery. Only `user_cancelled` qualifies: timeouts,
 * programmatic aborts, and steer (which never cancels the turn) produce no
 * marker, and a cancelled queued turn publishes no `turn.ended` at all. If
 * the last durable message already is the interruption reminder (repeated
 * cancellations with no message in between, a trailing vacuous open
 * assistant left by the cancelled turn notwithstanding), appending is
 * skipped so markers do not stack in practice — a reminder still deferred
 * behind an unsettled tool exchange is invisible to that check, accepted
 * since a second cancellation cannot normally arrive before the exchange
 * settles. Bound at Agent scope and constructed with the scope so the
 * subscription exists before the first turn runs (same rationale as
 * `loopContinuation`).
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';

import { IAgentLoopInterruptionReminderService } from './interruptionReminder';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

const INTERRUPTION_REMINDER = [
  'The previous turn was interrupted by the user before completion;',
  'any partial output shown above is incomplete.',
  "The user's next message continues the conversation.",
].join(' ');

export class AgentLoopInterruptionReminderService
  extends Disposable
  implements IAgentLoopInterruptionReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
  ) {
    super();
    this._register(
      eventBus.subscribe('turn.ended', (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        this.appendInterruptionReminder();
      }),
    );
  }

  private appendInterruptionReminder(): void {
    const origin = lastDurableMessageOrigin(this.context.get());
    if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return;
    this.reminders.appendSystemReminder(INTERRUPTION_REMINDER, {
      kind: 'injection',
      variant: INTERRUPTION_REMINDER_VARIANT,
    });
  }
}

/**
 * Origin of the last message that survives the fold, skipping a trailing open
 * assistant the cancelled turn left with nothing sendable recorded (the fold
 * drops it as vacuous at the next `step.begin`). Judging dedup against it
 * would let markers stack around the dropped shell (e.g. an empty retry turn
 * interrupted before its first token).
 */
function lastDurableMessageOrigin(
  messages: readonly ContextMessage[],
): ContextMessage['origin'] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (
      message.role === 'assistant' &&
      message.partial === true &&
      message.toolCalls.length === 0 &&
      message.content.every(isVacuousContentPart)
    ) {
      continue;
    }
    return message.origin;
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopInterruptionReminderService,
  AgentLoopInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'loop',
);
