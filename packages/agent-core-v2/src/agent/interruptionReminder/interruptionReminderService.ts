import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { isUserCancellation } from '#/_base/utils/abort';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentStateService } from '#/agent/state/agentState';

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
    @IAgentLoopService private readonly context: IAgentLoopService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IAgentStateService agentState: IAgentStateService,
  ) {
    super();
    agentState.contributeState(interruptionReminderKey);
  }

  notifyUserCancellation(reason: unknown): void {
    if (!isUserCancellation(reason)) return;
    const history = this.context.history();
    const origin = lastComparableMessage(history)?.origin;
    if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return;
    this.reminder.notify(INTERRUPTION_REMINDER, {
      variant: INTERRUPTION_REMINDER_VARIANT,
      ownerPromptId: this.context.snapshot().activePromptId,
    });
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
