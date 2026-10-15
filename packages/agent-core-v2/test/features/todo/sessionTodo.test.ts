import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { TodoFeature } from '#/features/todo/todoFeature';
import { IAgentTodoService } from '#/features/todo/todoService';
import type { TodoItem } from '#/features/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/features/todo/todoListReminder';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { WireRecord } from '#/wire/record';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

function reminderCount(memory: IAgentContextMemoryService): number {
  return memory.get().filter(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT,
  ).length;
}

function appendAssistantTurns(memory: IAgentContextMemoryService, count: number): void {
  for (let i = 0; i < count; i += 1) {
    memory.append({
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
      toolCalls: [],
    });
  }
}

describe('AgentTodoService', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('replaces, reads, and clears todos through the domain API', async () => {
    const todo = ctx.get(IAgentTodoService);

    expect(todo.get()).toEqual([]);

    await todo.replace([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);
    expect(todo.get()).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);

    await todo.clear();
    expect(todo.get()).toEqual([]);
  });

  it('emits each actual change once', async () => {
    const todo = ctx.get(IAgentTodoService);
    const seen: TodoItem[][] = [];
    const subscription = todo.onDidChange((todos) => { seen.push([...todos]); });

    await todo.replace([{ title: 'a', status: 'pending' }]);
    await todo.replace([
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'done' },
    ]);
    await todo.clear();

    expect(seen).toEqual([
      [{ title: 'a', status: 'pending' }],
      [
        { title: 'a', status: 'pending' },
        { title: 'b', status: 'done' },
      ],
      [],
    ]);
    subscription.dispose();
  });

  it('appends todos through the existing tools.update_store wire record', async () => {
    const todo = ctx.get(IAgentTodoService);
    await todo.replace([{ title: 'persist me', status: 'in_progress' }]);

    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'tools.update_store')).toEqual([{
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [{ title: 'persist me', status: 'in_progress' }],
      time: expect.any(Number),
    }]);
  });

  it('isolates todos between agents', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const mainTodo = ctx.get(IAgentTodoService);
    const subTodo = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentTodoService);

    await mainTodo.replace([{ title: 'main todo', status: 'pending' }]);
    await subTodo.replace([{ title: 'sub todo', status: 'done' }]);

    expect(mainTodo.get()).toEqual([{ title: 'main todo', status: 'pending' }]);
    expect(subTodo.get()).toEqual([{ title: 'sub todo', status: 'done' }]);
    await lifecycle.remove(sub);
  });

  it('restores todos from persisted wire records after restart', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = createTestAgent({ persistence, autoConfigure: false });
    await first.restorePersisted();
    await first.get(IAgentTodoService).replace([{ title: 'kept', status: 'in_progress' }]);
    await first.dispose();

    const restarted = createTestAgent({ persistence, autoConfigure: false });
    try {
      await restarted.restorePersisted();
      expect(restarted.get(IAgentTodoService).get()).toEqual([
        { title: 'kept', status: 'in_progress' },
      ]);
    } finally {
      await restarted.dispose();
    }
  });

  it('restores todos and resumes operations when the feature is re-provided after restore', async () => {
    await ctx.get(IAgentTodoService).replace([{ title: 'kept', status: 'in_progress' }]);

    await ctx.get(IFeatureManager).unprovideUnit('todo');
    expect(() => ctx.get(IAgentTodoService)).toThrow("unknown service 'agentTodoService'");

    ctx.get(IFeatureManager).provideUnit(TodoFeature);

    const revived = await vi.waitFor(() => {
      const service = ctx.get(IAgentTodoService);
      expect(service.get()).toEqual([{ title: 'kept', status: 'in_progress' }]);
      return service;
    });
    await revived.replace([
      { title: 'kept', status: 'done' },
      { title: 'added', status: 'pending' },
    ]);
    expect(revived.get()).toEqual([
      { title: 'kept', status: 'done' },
      { title: 'added', status: 'pending' },
    ]);
  });

  it('filters malformed persisted values during replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const seeded = createTestAgent({ persistence, autoConfigure: false });
    try {
      persistence.records.push({
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
        ],
      } as unknown as WireRecord);
      await seeded.restorePersisted();

      expect(seeded.get(IAgentTodoService).get()).toEqual([{ title: 'valid', status: 'done' }]);
    } finally {
      await seeded.dispose();
    }
  });

  it('reminds the main agent only while its list has open items', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const todo = ctx.get(IAgentTodoService);
    const reminder = ctx.get(IAgentReminderService);

    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(0);

    await todo.replace([{ title: 'track me', status: 'pending' }]);
    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(1);

    await todo.replace([{ title: 'track me', status: 'done' }]);
    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(1);

    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const subTodo = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentTodoService);
    const subReminder = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentReminderService);
    const subMemory = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentContextMemoryService);
    await subTodo.replace([{ title: 'sub task', status: 'pending' }]);
    appendAssistantTurns(subMemory, 5);
    await subReminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(subMemory)).toBe(0);
    await lifecycle.remove(sub);
  });

  it('tracks stale reminders and how each main-agent turn leaves the list', async () => {
    const records: TelemetryRecord[] = [];
    const tracked = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      await tracked.restorePersisted();
      const todo = tracked.get(IAgentTodoService);
      const bus = tracked.get(IEventBus);

      bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
      await todo.replace([
        { title: 'parse config', status: 'done' },
        { title: 'update callers', status: 'in_progress' },
      ]);
      appendAssistantTurns(tracked.context, 5);
      await tracked.get(IAgentReminderService).reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 2, origin: { kind: 'user' } }));
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 2, reason: 'cancelled' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 3, origin: { kind: 'user' } }));
      await todo.replace([]);
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 3, reason: 'completed' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 4, origin: { kind: 'user' } }));
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 4, reason: 'completed' }));

      const propertiesOf = (event: string) =>
        records.filter((record) => record.event === event).map((record) => record.properties);
      expect(propertiesOf('todo_reminder_shown')).toEqual([
        expect.objectContaining({ steps_since_write: 5, item_count: 2, open_count: 1 }),
      ]);
      expect(propertiesOf('todo_turn_ended')).toEqual([
        expect.objectContaining({
          turn_id: 1,
          reason: 'completed',
          item_count: 2,
          open_count: 1,
          updated_in_turn: true,
        }),
        expect.objectContaining({
          turn_id: 2,
          reason: 'cancelled',
          item_count: 2,
          open_count: 1,
          updated_in_turn: false,
        }),
        expect.objectContaining({
          turn_id: 3,
          reason: 'completed',
          item_count: 0,
          open_count: 0,
          updated_in_turn: true,
        }),
      ]);
    } finally {
      await tracked.dispose();
    }
  });
});

describe('KeyedResourceLeasePool', () => {
  function nextTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('deduplicates concurrent materialization by key', async () => {
    let creates = 0;
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 1 },
      async () => {
        creates += 1;
        await nextTick();
        return { dispose: () => {} };
      },
    );

    const [first, second] = await Promise.all([pool.acquire('main'), pool.acquire('main')]);
    expect(creates).toBe(1);
    expect(first.resource).toBe(second.resource);
    first.release();
    second.release();
    await pool.withdraw();
  });

  it('rejects stale generation acquires while an existing lease drains', async () => {
    let disposed = false;
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 2 },
      () => ({
        dispose: async () => {
          await nextTick();
          disposed = true;
        },
      }),
    );
    const lease = await pool.acquire('main');
    const withdrawal = pool.withdraw();

    await expect(pool.acquire('main')).rejects.toThrow('todo.test:2 is withdrawn');
    await nextTick();
    expect(disposed).toBe(false);
    lease.release();
    await withdrawal;
    expect(disposed).toBe(true);
  });
});
