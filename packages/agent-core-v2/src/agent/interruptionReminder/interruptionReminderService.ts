/**
 * `interruptionReminder` domain (L4) — `IAgentInterruptionReminderService` implementation.
 *
 * Observes turn completion through `event`, persists reminder completion through
 * its own wire model, reads conversation history through `contextMemory`, and
 * appends model-visible notices through `systemReminder`. Reconciles reminders
 * left pending by an interrupted restore. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';

import { IAgentInterruptionReminderService } from './interruptionReminder';
import { interruptionReminderRecorded, InterruptionReminderModel } from './interruptionReminderOps';

export const INTERRUPTION_REMINDER_VARIANT = 'interruption';

const INTERRUPTION_REMINDER = [
  'The previous turn was interrupted by the user before completion;',
  'any partial output shown above is incomplete.',
  "The user's next message continues the conversation.",
].join(' ');

export class AgentInterruptionReminderService
  extends Service
  implements IAgentInterruptionReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IWireService private readonly wire: IWireService,
  ) {
    super();
    this._register(
      this.wire.hooks.onDidRestore.register('interruption-reminder', async (_ctx, next) => {
        this.reconcilePendingReminders();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe('turn.ended', (event) => {
        if (event.reason !== 'cancelled' || event.interruptReason !== 'user_cancelled') return;
        this.recordReminder(event.turnId, true);
      }),
    );
  }

  private reconcilePendingReminders(): void {
    const pending = this.wire.getModel(InterruptionReminderModel);
    for (const turnId of pending) this.recordReminder(turnId);
  }

  private recordReminder(turnId: number, allowUntracked = false): void {
    const pending = this.wire.getModel(InterruptionReminderModel).includes(turnId);
    if (!pending && !allowUntracked) return;
    if (!this.appendInterruptionReminder()) return;
    if (pending) this.wire.dispatch(interruptionReminderRecorded({ turnId }));
  }

  private appendInterruptionReminder(): boolean {
    const before = this.context.get();
    const origin = lastDurableMessageOrigin(before);
    if (origin?.kind === 'injection' && origin.variant === INTERRUPTION_REMINDER_VARIANT) return true;
    this.reminders.appendSystemReminder(INTERRUPTION_REMINDER, {
      kind: 'injection',
      variant: INTERRUPTION_REMINDER_VARIANT,
    });
    const after = this.context.get();
    if (after === before) return false;
    const appended = lastDurableMessageOrigin(after);
    return appended?.kind === 'injection' && appended.variant === INTERRUPTION_REMINDER_VARIANT;
  }
}

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
  IAgentInterruptionReminderService,
  AgentInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'interruptionReminder',
);
