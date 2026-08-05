/**
 * Scenario: once-reminder queue — persistence, FIFO delivery, exactly-once
 * crash-window reconciliation, and ledger immunity to undo.
 *
 * Exercises the real queue service against a real wire backed by an in-memory
 * journal and a stub context. Run: `pnpm --filter @moonshot-ai/agent-core-v2
 * exec vitest run test/agent/reminderQueue/reminderQueue.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { CHECKPOINTED_MODELS } from '#/agent/contextMemory/conversationTime';
import { IAgentReminderQueueService } from '#/agent/reminderQueue/reminderQueue';
import { ReminderQueueModel } from '#/agent/reminderQueue/reminderQueueOps';
import { AgentReminderQueueService } from '#/agent/reminderQueue/reminderQueueService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { registerContextMemoryServices } from '../contextMemory/stubs';
import { recordingWireLog, registerTestAgentWire, restoreTestAgentWire } from '../../wire/stubs';

const SCOPE = 'reminder-queue-test';

describe('AgentReminderQueueService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let records: WireRecord[];
  let log: ReturnType<typeof recordingWireLog>;
  let wire: IWireService;
  let context: IAgentContextMemoryService;
  let queue: IAgentReminderQueueService;
  let reminders: IAgentSystemReminderService;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    log = recordingWireLog(records);
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.define(IAgentSystemReminderService, AgentSystemReminderService);
        reg.define(IAgentReminderQueueService, AgentReminderQueueService);
      },
    });
    wire = registerTestAgentWire(ix, SCOPE, { log });
    context = ix.get(IAgentContextMemoryService);
    queue = ix.get(IAgentReminderQueueService);
    reminders = ix.get(IAgentSystemReminderService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  function injectionMessages() {
    return context.get().filter((m) => m.origin?.kind === 'injection');
  }

  it('is not a checkpointed model (undo never revives the delivery ledger)', () => {
    expect(CHECKPOINTED_MODELS.some((model) => model.name === ReminderQueueModel.name)).toBe(false);
  });

  it('persists enqueued entries and replays them into the pending ledger', async () => {
    const journal = [
      {
        type: 'reminderQueue.enqueue',
        entry: { id: 'e1', variant: 'interruption', content: 'first' },
      },
      {
        type: 'reminderQueue.enqueue',
        entry: { id: 'e2', variant: 'init', content: 'second', ownerPromptId: 'p1' },
      },
    ] as unknown as WireRecord[];

    await restoreTestAgentWire(wire, log, SCOPE, journal);

    const pending = wire.getModel(ReminderQueueModel);
    expect(pending).toHaveLength(2);
    expect(pending.map((entry) => [entry.variant, entry.content])).toEqual([
      ['interruption', 'first'],
      ['init', 'second'],
    ]);
    expect(pending[1]!.ownerPromptId).toBe('p1');
  });

  it('drains pending entries FIFO, wraps them as system reminders, and clears the ledger', () => {
    queue.enqueue({ variant: 'a', content: 'first' });
    queue.enqueue({ variant: 'b', content: 'second', ownerPromptId: 'p1' });

    queue.drain();

    const messages = context.get();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>\nfirst\n</system-reminder>' }],
      origin: { kind: 'injection', variant: 'a' },
    });
    expect(messages[1]).toMatchObject({
      content: [{ type: 'text', text: '<system-reminder>\nsecond\n</system-reminder>' }],
      origin: { kind: 'injection', variant: 'b', ownerPromptId: 'p1' },
    });
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
    expect(records.map((record) => record.type)).toEqual([
      'reminderQueue.enqueue',
      'reminderQueue.enqueue',
      'reminderQueue.delivered',
      'reminderQueue.delivered',
    ]);
  });

  it('collapses consecutive identical entries into a single reminder', () => {
    queue.enqueue({ variant: 'interruption', content: 'same' });
    queue.enqueue({ variant: 'interruption', content: 'same' });

    queue.drain();

    expect(injectionMessages()).toHaveLength(1);
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
  });

  it('delivers entries left pending by a crash (restore drain)', async () => {
    const journal = [
      {
        type: 'reminderQueue.enqueue',
        entry: { id: 'e1', variant: 'interruption', content: 'pending at crash' },
      },
    ] as unknown as WireRecord[];

    await restoreTestAgentWire(wire, log, SCOPE, journal);

    expect(wire.getModel(ReminderQueueModel)).toHaveLength(1);
    queue.drain();
    expect(injectionMessages()).toHaveLength(1);
    expect(injectionMessages()[0]).toMatchObject({
      content: [{ type: 'text', text: '<system-reminder>\npending at crash\n</system-reminder>' }],
      origin: { kind: 'injection', variant: 'interruption' },
    });
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
  });

  it('reconciles an appended-but-unrecorded delivery after restore without duplicating', async () => {
    // The reminder append landed (persisted as context.append_message, so it
    // sits at the conversation tail after the context replays), but the
    // delivered record never reached the journal.
    reminders.appendSystemReminder('crash window', {
      kind: 'injection',
      variant: 'interruption',
    });
    const journal = [
      {
        type: 'reminderQueue.enqueue',
        entry: { id: 'e1', variant: 'interruption', content: 'crash window' },
      },
    ] as unknown as WireRecord[];

    await restoreTestAgentWire(wire, log, SCOPE, journal);
    expect(wire.getModel(ReminderQueueModel)).toHaveLength(1);

    queue.drain();

    expect(injectionMessages()).toHaveLength(1);
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
  });

  it('skips vacuous partial assistant messages when matching the conversation tail', async () => {
    reminders.appendSystemReminder('crash window', {
      kind: 'injection',
      variant: 'interruption',
    });
    context.append({ role: 'assistant', content: [], toolCalls: [], partial: true });
    const journal = [
      {
        type: 'reminderQueue.enqueue',
        entry: { id: 'e1', variant: 'interruption', content: 'crash window' },
      },
    ] as unknown as WireRecord[];

    await restoreTestAgentWire(wire, log, SCOPE, journal);

    queue.drain();

    expect(injectionMessages()).toHaveLength(1);
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
  });

  it('appends a fresh reminder when the tail holds an older, different one', () => {
    queue.enqueue({ variant: 'interruption', content: 'earlier' });
    queue.drain();
    queue.enqueue({ variant: 'interruption', content: 'latest' });

    queue.drain();

    expect(injectionMessages()).toHaveLength(2);
    expect(wire.getModel(ReminderQueueModel)).toEqual([]);
  });
});
