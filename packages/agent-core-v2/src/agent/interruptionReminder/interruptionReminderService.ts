/**
 * `interruptionReminder` domain — `IAgentInterruptionReminderService` implementation.
 *
 * Observes completed turns through `eventBus`, appends user-cancellation facts
 * through `systemReminder` at the event point, and reads `contextMemory` to
 * collapse retry-only duplicate notices. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';

import { IAgentInterruptionReminderService } from './interruptionReminder';
import { INTERRUPTION_REMINDER_VARIANT, interruptionReminderKey } from './interruptionReminderOps';

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
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentStateService agentState: IAgentStateService,
  ) {
    super();
    agentState.contributeState(interruptionReminderKey);
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        const origin = lastComparableMessage(this.context.get())?.origin;
        if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return;
        this.reminders.appendSystemReminder(INTERRUPTION_REMINDER, {
          kind: 'injection',
          variant: INTERRUPTION_REMINDER_VARIANT,
        });
      }),
    );
  }
}

function lastComparableMessage(messages: readonly ContextMessage[]): ContextMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role === 'assistant' &&
      message.partial === true &&
      message.toolCalls.length === 0 &&
      message.content.every(isVacuousContentPart)
    ) {
      continue;
    }
    return message;
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentInterruptionReminderService,
  AgentInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'interruptionReminder',
);
