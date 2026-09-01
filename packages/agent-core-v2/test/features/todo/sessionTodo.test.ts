import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { TodoFeature } from '#/features/todo/todoFeature';
import { IAgentTodoService } from '#/features/todo/todoService';
import type { TodoItem } from '#/features/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/features/todo/todoListReminder';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { WireRecord } from '#/wire/record';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

function reminderInjected(ctx: TestAgentContext): boolean {
  return ctx.context.get().some(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT,
  );
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

  it('arms the stale-todo reminder on first use for the main agent only', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const todo = ctx.get(IAgentTodoService);
    const reminder = ctx.get(IAgentReminderService);

    appendAssistantTurns(ctx.context, 10);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderInjected(ctx)).toBe(false);

    await todo.replace([{ title: 'track me', status: 'pending' }]);
    appendAssistantTurns(ctx.context, 10);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderInjected(ctx)).toBe(true);

    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const subTodo = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentTodoService);
    const subReminder = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentReminderService);
    const subMemory = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentContextMemoryService);
    await subTodo.replace([{ title: 'sub task', status: 'pending' }]);
    appendAssistantTurns(subMemory, 10);
    await subReminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(
      subMemory.get().some(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === TODO_LIST_REMINDER_VARIANT,
      ),
    ).toBe(false);
    await lifecycle.remove(sub);
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
