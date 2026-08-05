/**
 * `reminderQueue` domain — `IAgentReminderQueueService` implementation.
 *
 * Persists once-reminder entries through its own wire Model, delivers them
 * through `systemReminder` (the unified write head), and schedules itself:
 * it drains on every `contextInjector` injection boundary (`onWillInject`).
 * Crash-window dedup reads the conversation tail through `contextMemory` and
 * matches the entry id recorded as the delivered reminder's disclosure, so a
 * reminder appended but not yet marked delivered is never re-appended after a
 * restart; entries identical within one drain collapse into a single
 * reminder. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
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
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(injector.onWillInject(() => {
      this.drain();
    }));
  }

  enqueue(input: OnceReminderInput): void {
    const entry: ReminderQueueEntry = { id: randomUUID(), ...input };
    this.wire.dispatch(reminderQueueEnqueue({ entry }));
  }

  drain(): void {
    const deliveredIds = this.deliveredIdsAtTail();
    const rendered = new Set<string>();
    for (const entry of this.wire.getModel(ReminderQueueModel)) {
      const collapseKey = `${entry.variant}\n${entry.content}`;
      if (!deliveredIds.has(entry.id) && !rendered.has(collapseKey)) {
        this.reminders.appendSystemReminder(entry.content, {
          kind: 'injection',
          variant: entry.variant,
          disclosure: { kind: 'once_reminder', id: entry.id },
        });
        rendered.add(collapseKey);
      }
      this.wire.dispatch(reminderQueueDelivered({ id: entry.id }));
    }
  }

  private deliveredIdsAtTail(): ReadonlySet<string> {
    const messages = this.context.get();
    const ids = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (isSkippableTailAssistant(message)) continue;
      const origin = message.origin;
      if (origin?.kind !== 'injection') break;
      if (origin.disclosure?.kind === 'once_reminder') ids.add(origin.disclosure.id);
    }
    return ids;
  }
}

function isSkippableTailAssistant(message: ContextMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.partial === true &&
    message.toolCalls.length === 0 &&
    message.content.every(isVacuousContentPart)
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentReminderQueueService,
  AgentReminderQueueService,
  ScopeActivation.OnScopeCreated,
  'reminderQueue',
);
