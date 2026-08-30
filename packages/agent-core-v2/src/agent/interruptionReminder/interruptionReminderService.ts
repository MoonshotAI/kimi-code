import { Disposable } from '#/_base/di/lifecycle';
import { AgentContextMemory, ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { isVacuousContentPart } from '#/actor/contextMemory/vacuousContent';
import { TurnEnded } from '#/actor/loop/turnOps';
import { AgentReminder } from '#/actor/reminder/reminderAgentRuntime';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
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

  private readonly context: ContextMemoryRuntime;

  constructor(
    @IEventBus eventBus: IEventBus,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    scopeContext: IAgentScopeContext,
    @IAgentStateService agentState: IAgentStateService,
  ) {
    super();
    this.context = agentLifecycle.resolve(scopeContext.agentContext, AgentContextMemory);
    agentState.contributeState(interruptionReminderKey);
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        const origin = lastComparableMessage(this.context.get())?.origin;
        if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return;
        agentLifecycle.resolve(scopeContext.agentContext, AgentReminder).notify(INTERRUPTION_REMINDER, {
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

