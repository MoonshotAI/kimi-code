/**
 * `interruptionReminder` domain (L4) — `IAgentInterruptionReminderService` implementation.
 *
 * Observes turn completion through `eventBus` and enqueues a one-time
 * user-interruption notice into the `reminderQueue`. Persistence, crash
 * recovery, and dedup are owned by the queue; delivery happens at the unified
 * boundary scheduler's drain points. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderQueueService } from '#/agent/reminderQueue/reminderQueue';
import { IEventBus } from '#/app/event/eventBus';

import { IAgentInterruptionReminderService } from './interruptionReminder';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

const INTERRUPTION_REMINDER = [
  'The previous turn was interrupted by the user before completion;',
  'any partial output shown above is incomplete.',
  "The user's next message continues the conversation.",
].join(' ');

export class AgentInterruptionReminderService
  extends Disposable
  implements IAgentInterruptionReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventBus eventBus: IEventBus,
    @IAgentReminderQueueService private readonly reminderQueue: IAgentReminderQueueService,
  ) {
    super();
    this._register(
      eventBus.subscribe('turn.ended', (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        this.reminderQueue.enqueue({
          variant: INTERRUPTION_REMINDER_VARIANT,
          content: INTERRUPTION_REMINDER,
        });
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentInterruptionReminderService,
  AgentInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'interruptionReminder',
);
