/**
 * `reminderQueue` domain — `IAgentReminderQueueService` implementation.
 *
 * Persists once-reminder entries through its own wire Model, delivers them
 * through `systemReminder` (the unified write head), and reads the
 * conversation tail through `contextMemory` for crash-window dedup. Delivery
 * scheduling is owned by the unified boundary scheduler (`contextInjector`),
 * not by this service. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IWireService } from '#/wire/wire';

import { IAgentReminderQueueService, type OnceReminderInput } from './reminderQueue';
import {
  ReminderQueueModel,
  type ReminderQueueEntry,
  reminderQueueDelivered,
  reminderQueueEnqueue,
} from './reminderQueueOps';

export class AgentReminderQueueService extends Disposable implements IAgentReminderQueueService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
  }

  enqueue(input: OnceReminderInput): string {
    const entry: ReminderQueueEntry = { id: randomUUID(), ...input };
    this.wire.dispatch(reminderQueueEnqueue({ entry }));
    return entry.id;
  }

  drain(): void {
    for (const entry of this.wire.getModel(ReminderQueueModel)) {
      // Exactly-once dedup: a crash between the reminder append (persisted as
      // `context.append_message`) and the delivered record leaves the entry
      // pending with its reminder already at the conversation tail — reconcile
      // by clearing the ledger instead of appending a duplicate.
      if (!this.alreadyDeliveredAtTail(entry)) {
        this.reminders.appendSystemReminder(entry.content, {
          kind: 'injection',
          variant: entry.variant,
          ownerPromptId: entry.ownerPromptId,
        });
      }
      this.wire.dispatch(reminderQueueDelivered({ id: entry.id }));
    }
  }

  private alreadyDeliveredAtTail(entry: ReminderQueueEntry): boolean {
    const last = lastDurableMessage(this.context.get());
    if (last?.origin?.kind !== 'injection' || last.origin.variant !== entry.variant) return false;
    return messageText(last) === `<system-reminder>\n${entry.content.trim()}\n</system-reminder>`;
  }
}

function lastDurableMessage(messages: readonly ContextMessage[]): ContextMessage | undefined {
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
    return message;
  }
  return undefined;
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentReminderQueueService,
  AgentReminderQueueService,
  ScopeActivation.OnScopeCreated,
  'reminderQueue',
);
