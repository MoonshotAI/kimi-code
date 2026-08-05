/**
 * `interruptionReminder` domain — `IAgentInterruptionReminderService` implementation.
 *
 * Projects checkpointed user-cancellation facts from `wire` through the
 * `contextInjector` turn-start boundary, and reads `contextMemory` to collapse
 * retry-only duplicate notices. The turn-start placement keeps the notice
 * between the interrupted turn and the next user prompt on provider wires.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IWireService } from '#/wire/wire';

import { IAgentInterruptionReminderService } from './interruptionReminder';
import {
  INTERRUPTION_REMINDER,
  INTERRUPTION_REMINDER_VARIANT,
  interruptionReminderRecorded,
  InterruptionReminderModel,
} from './interruptionReminderOps';

export class AgentInterruptionReminderService
  extends Disposable
  implements IAgentInterruptionReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWireService private readonly wire: IWireService,
  ) {
    super();
    this._register(
      injector.registerAtTurnStart(
        INTERRUPTION_REMINDER_VARIANT,
        () => this.reconcileReminder(),
      ),
    );
  }

  private reconcileReminder(): string | undefined {
    const pending = this.wire.getModel(InterruptionReminderModel).current;
    if (pending.length === 0) return undefined;
    const origin = lastComparableMessage(this.context.get())?.origin;
    if (origin?.kind !== 'injection' || origin.variant !== INTERRUPTION_REMINDER_VARIANT) {
      return INTERRUPTION_REMINDER;
    }
    this.wire.dispatch(...pending.map((turnId) => interruptionReminderRecorded({ turnId })));
    return undefined;
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
