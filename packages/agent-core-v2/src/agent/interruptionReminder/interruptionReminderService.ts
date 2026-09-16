import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { HistoryMessage } from '#human/agent/turn';
import { isUserEntry } from '#human/agent/turn';
import { isAssistantEntry } from '#human/agent/turn';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentReminderService } from '#/features/reminder/reminderService';
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
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAgentStateService agentState: IAgentStateService,
  ) {
    super();
    agentState.contributeState(interruptionReminderKey);
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        const last = lastComparableMessage(this.context.get());
        const origin = last !== undefined && isUserEntry(last) ? last.meta?.origin : undefined;
        if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return;
        this.reminder.notify(INTERRUPTION_REMINDER, {
          variant: INTERRUPTION_REMINDER_VARIANT,
        });
      }),
    );
  }
}

function lastComparableMessage(messages: readonly HistoryMessage[]): HistoryMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      isAssistantEntry(message) &&
      message.meta?.partial === true &&
      message.message.toolCalls.length === 0 &&
      message.message.content.every(isVacuousContentPart)
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
