import { describe, expect, it } from 'vitest';
import { fromCallback } from 'xstate';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeDefinitionRecord,
  getAgentRuntimeDefinitionId,
} from '#/agent/runtime/agentRuntime';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { createReminderStub, lifecycleWithReminder } from '../reminder/stubs';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ContextAppendMessage, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ManagedAgent } from '#/session/agentLifecycle/managedAgent';
import {
  AgentTodo,
  todoAgentRuntimeProvider,
  type TodoRuntime,
} from '#/features/todo/todoAgentRuntime';
import type { TodoItem } from '#/features/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/features/todo/todoListReminder';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import { stubWireJournal } from '../../wire/stubs';

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

interface RuntimeAgent {
  readonly context: AgentContext;
  readonly managed: ManagedAgent;
  readonly todo: TodoRuntime;
  readonly dispatcher: IEventDispatcher;
  readonly journal: WireRecord[];
  readonly registeredVariants: string[];
  readonly activeReminders: () => number;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

function todoRecord(generation = 1): AgentRuntimeDefinitionRecord {
  return {
    definition: AgentTodo,
    provider: todoAgentRuntimeProvider,
    generation,
    providerGeneration: generation,
    active: true,
  };
}

class RuntimeRegistry {
  private readonly managed = new Set<ManagedAgent>();
  private readonly records = new Map<string, AgentRuntimeDefinitionRecord>();

  register(record: AgentRuntimeDefinitionRecord): void {
    const id = getAgentRuntimeDefinitionId(record.definition);
    this.records.set(id, record);
    for (const managed of this.managed) managed.runtimeSet.apply(record);
  }

  withdraw(record: AgentRuntimeDefinitionRecord): void {
    const id = getAgentRuntimeDefinitionId(record.definition);
    if (this.records.get(id) !== record) return;
    this.records.delete(id);
    record.active = false;
    for (const managed of this.managed) managed.runtimeSet.retireDefinition(record);
  }

  track(managed: ManagedAgent): void {
    this.managed.add(managed);
    for (const record of this.records.values()) managed.runtimeSet.apply(record);
  }

  untrack(managed: ManagedAgent): void {
    this.managed.delete(managed);
  }

  current(capabilityId: string): AgentRuntimeDefinitionRecord {
    const record = this.records.get(capabilityId);
    if (record === undefined) throw new Error(`No record for '${capabilityId}'`);
    return record;
  }
}

function makeRuntimeAgent(
  registry: RuntimeRegistry,
  agentId: string,
  generation = 1,
): RuntimeAgent {
  const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, generation });
  const context = scope.agentContext;
  const journal: WireRecord[] = [];
  const registeredVariants: string[] = [];
  let reminders = 0;
  const eventBus = new EventBusService();
  eventBus.activateAgent(context);
  const ix = new TestInstantiationService();
  ix.set(IAgentScopeContext, scope);
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IEventBus, eventBus);
  ix.set(IWireService, stubWireJournal(journal));
  ix.set(
    IAgentLifecycleService,
    lifecycleWithReminder(createReminderStub({
      register: (variant: string) => {
        registeredVariants.push(variant);
        reminders += 1;
        return toDisposable(() => { reminders -= 1; });
      },
    })),
  );
  ix.set(IAgentContextMemoryService, {
    _serviceBrand: undefined,
    get: () => [],
  } as unknown as IAgentContextMemoryService);
  ix.set(IAgentToolPolicyService, {
    _serviceBrand: undefined,
    isToolActive: () => false,
  } as unknown as IAgentToolPolicyService);
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: ix,
    dispose: () => { ix.dispose(); },
  };
  const managed = new ManagedAgent(context, handle, []);
  registry.track(managed);
  managed.attachDurableRuntimes();
  const dispatcher = ix.get(IEventDispatcher);
  void managed.runtimeSet.restore();
  return {
    context,
    managed,
    todo: managed.runtimeSet.resolve(AgentTodo),
    dispatcher,
    journal,
    registeredVariants,
    activeReminders: () => reminders,
    restore: async (records) => {
      journal.push(...records);
      await dispatcher.restore();
      await managed.runtimeSet.restore();
    },
    dispose: async () => {
      registry.untrack(managed);
      await managed.runtimeSet.close();
      managed.killSpace();
      await handle.dispose();
    },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TodoAgentRuntime', () => {
  it('isolates state by agent and generation', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const main = makeRuntimeAgent(registry, 'main', 1);
    const sub = makeRuntimeAgent(registry, 'agent-1', 1);
    const next = makeRuntimeAgent(registry, 'main', 2);

    await main.todo.replace([{ title: 'main todo', status: 'pending' }]);
    await sub.todo.replace([{ title: 'sub todo', status: 'done' }]);

    expect(main.todo.get()).toEqual([{ title: 'main todo', status: 'pending' }]);
    expect(sub.todo.get()).toEqual([{ title: 'sub todo', status: 'done' }]);
    expect(next.todo.get()).toEqual([]);
    expect(main.registeredVariants).toEqual([TODO_LIST_REMINDER_VARIANT]);
    expect(sub.activeReminders()).toBe(0);
    await main.dispose();
    await sub.dispose();
    await next.dispose();
  });

  it('materializes durable state before runtime creation and arms the reminder on first use', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main', generation: 1 });
    const ix = new TestInstantiationService();
    let reminders = 0;
    ix.set(IAgentScopeContext, scope);
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventBus, new EventBusService());
    ix.set(IWireService, stubWireJournal([]));
    ix.set(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub({
        register: () => {
          reminders += 1;
          return toDisposable(() => { reminders -= 1; });
        },
      })),
    );
    ix.set(IAgentContextMemoryService, {
      _serviceBrand: undefined,
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    ix.set(IAgentToolPolicyService, {
      _serviceBrand: undefined,
      isToolActive: () => false,
    } as unknown as IAgentToolPolicyService);
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const handle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: ix,
      dispose: () => { ix.dispose(); },
    };
    const managed = new ManagedAgent(scope.agentContext, handle, [todoRecord()]);
    managed.attachDurableRuntimes();

    expect(reminders).toBe(0);
    expect(managed.runtimeSet.inspect()[0]).toMatchObject({
      status: 'materialized',
      state: [],
    });

    void managed.runtimeSet.restore();
    const todo = managed.runtimeSet.resolve(AgentTodo);
    expect(reminders).toBe(0);
    expect(todo.get()).toEqual([]);
    expect(reminders).toBe(1);
    expect(todo.get()).toEqual([]);
    expect(reminders).toBe(1);
    expect(managed.runtimeSet.resolve(AgentTodo)).toBe(todo);
    expect(reminders).toBe(1);
    await managed.runtimeSet.close();
    await handle.dispose();
  });

  it('rejects resolve and lease tracking once the runtime set is closed', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const agent = makeRuntimeAgent(registry, 'main', 1);

    await agent.dispose();

    expect(() => agent.managed.runtimeSet.resolve(AgentTodo)).toThrow('closed');
    expect(agent.managed.runtimeSet.inspect()[0]).toMatchObject({ status: 'retired' });
  });

  it('uses the definition as the typed resolve token', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const agent = makeRuntimeAgent(registry, 'main');
    const manager = {
      resolve: () => agent.managed.runtimeSet.resolve(AgentTodo),
    } as unknown as IAgentLifecycleService;

    const todo = manager.resolve(agent.context, AgentTodo);

    expect(todo.get()).toEqual([]);
    todo.onDidChange(() => {}).dispose();
    expect(manager.resolve(agent.context, AgentTodo)).toBe(todo);
    await agent.dispose();
  });

  it('appends the existing tools.update_store wire and restores malformed values safely', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const agent = makeRuntimeAgent(registry, 'main');
    await agent.todo.replace([{ title: 'persist me', status: 'in_progress' }]);

    expect(agent.journal).toEqual([{
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [{ title: 'persist me', status: 'in_progress' }],
      time: expect.any(Number),
    }]);

    const restoredRegistry = new RuntimeRegistry();
    restoredRegistry.register(todoRecord());
    const restored = makeRuntimeAgent(restoredRegistry, 'main');
    await restored.restore([{
      type: 'tools.update_store',
      key: 'todo',
      value: [
        { title: 'valid', status: 'done' },
        { title: 'missing status' },
        { title: 123, status: 'pending' },
        'garbage',
      ],
    } as unknown as WireRecord]);

    expect(restored.todo.get()).toEqual([{ title: 'valid', status: 'done' }]);
    await agent.dispose();
    await restored.dispose();
  });

  it('restores conversation undo and emits each actual change once', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord());
    const agent = makeRuntimeAgent(registry, 'main');
    const seen: TodoItem[][] = [];
    const subscription = agent.todo.onDidChange((todos) => { seen.push([...todos]); });

    await agent.dispatcher.dispatch(new ContextAppendMessage({
      agentId: 'main',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    }));
    await agent.todo.replace([{ title: 'kept', status: 'pending' }]);
    await agent.dispatcher.dispatch(new ContextAppendMessage({
      agentId: 'main',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    }));
    await agent.todo.replace([{ title: 'doomed', status: 'in_progress' }]);
    seen.length = 0;

    await agent.dispatcher.dispatch(new ContextUndo({ agentId: 'main', count: 1 }));
    await agent.dispatcher.dispatch(new ContextUndo({ agentId: 'main', count: 0 }));

    expect(agent.todo.get()).toEqual([{ title: 'kept', status: 'pending' }]);
    expect(seen).toEqual([[{ title: 'kept', status: 'pending' }]]);
    subscription.dispose();
    await agent.dispose();
  });

  it('stops actors on agent close and on definition withdraw', async () => {
    const registry = new RuntimeRegistry();
    const record = todoRecord();
    registry.register(record);
    const main = makeRuntimeAgent(registry, 'main');
    const sub = makeRuntimeAgent(registry, 'agent-1');
    expect(main.activeReminders()).toBe(0);
    expect(sub.activeReminders()).toBe(0);

    expect(main.todo.get()).toEqual([]);
    expect(sub.todo.get()).toEqual([]);
    expect(main.activeReminders()).toBe(1);
    expect(sub.activeReminders()).toBe(0);

    await main.dispose();
    expect(main.activeReminders()).toBe(0);
    expect(sub.activeReminders()).toBe(0);
    expect(() => main.managed.runtimeSet.resolve(AgentTodo)).toThrow('closed');

    registry.withdraw(record);
    await nextTick();
    expect(sub.activeReminders()).toBe(0);
    expect(() => sub.managed.runtimeSet.resolve(AgentTodo)).toThrow('unavailable');
    await sub.dispose();
  });

  it('materializes non-durable definitions lazily on first resolve', async () => {
    let creates = 0;
    const ephemeral = defineAgentRuntimeContract<object>('ephemeral-runtime');
    const ephemeralProvider = defineAgentRuntimeProvider<undefined, object>(ephemeral, {
      id: 'ephemeral-runtime',
      logic: fromCallback(() => {}),
      createApi: () => {
        creates += 1;
        return {};
      },
    });
    const registry = new RuntimeRegistry();
    registry.register({
      definition: ephemeral,
      provider: ephemeralProvider,
      generation: 1,
      active: true,
    });
    const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main', generation: 1 });
    const ix = new TestInstantiationService();
    ix.set(IAgentScopeContext, scope);
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventBus, new EventBusService());
    ix.set(IWireService, stubWireJournal([]));
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const handle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: ix,
      dispose: () => { ix.dispose(); },
    };
    const managed = new ManagedAgent(scope.agentContext, handle, []);
    registry.track(managed);
    managed.attachDurableRuntimes();

    expect(creates).toBe(0);
    expect(managed.runtimeSet.inspect()[0]).toMatchObject({ status: 'registered' });
    managed.runtimeSet.resolve(ephemeral);
    expect(creates).toBe(1);
    expect(managed.runtimeSet.inspect()[0]).toMatchObject({ status: 'materialized' });
    await managed.runtimeSet.close();
    await handle.dispose();
  });

  it('reports registered, materialized, retired, and definition generations', async () => {
    const registry = new RuntimeRegistry();
    registry.register(todoRecord(1));
    const agent = makeRuntimeAgent(registry, 'main');

    expect(agent.managed.runtimeSet.inspect()[0]).toMatchObject({
      id: 'todo',
      generation: 1,
      status: 'materialized',
      state: [],
    });
    registry.withdraw(registry.current('todo'));
    expect(agent.managed.runtimeSet.inspect()[0]).toMatchObject({ status: 'retired' });
    registry.register(todoRecord(2));
    expect(agent.managed.runtimeSet.inspect()[0]).toMatchObject({
      generation: 2,
      status: 'materialized',
      state: [],
    });
    await agent.dispose();
  });

  it('keeps registered status until a durable definition is attached', async () => {
    const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main', generation: 1 });
    const ix = new TestInstantiationService();
    ix.set(IAgentScopeContext, scope);
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventBus, new EventBusService());
    ix.set(IWireService, stubWireJournal([]));
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const handle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: ix,
      dispose: () => { ix.dispose(); },
    };
    const managed = new ManagedAgent(scope.agentContext, handle, [todoRecord()]);

    expect(managed.runtimeSet.inspect()[0]).toMatchObject({
      id: 'todo',
      generation: 1,
      status: 'registered',
    });
    managed.attachDurableRuntimes();
    expect(managed.runtimeSet.inspect()[0]).toMatchObject({ status: 'materialized', state: [] });
    await managed.runtimeSet.close();
    await handle.dispose();
  });

  it('retains actor failure status and inspection diagnostics', async () => {
    const definition = defineAgentRuntimeContract<object>('failed-runtime');
    const provider = defineAgentRuntimeProvider<number, object>(definition, {
      id: 'failed-runtime',
      logic: fromCallback(() => { throw new Error('actor failed'); }),
      durable: {
        events: [],
        undoable: false,
        transition: () => {},
        read: () => 0,
        commit: () => {},
      },
      createApi: () => ({}),
      inspect: () => ({ value: 0 }),
    });
    const registry = new RuntimeRegistry();
    registry.register({
      definition,
      provider,
      generation: 1,
      active: true,
    });
    const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main', generation: 1 });
    const ix = new TestInstantiationService();
    ix.set(IAgentScopeContext, scope);
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventBus, new EventBusService());
    ix.set(IWireService, stubWireJournal([]));
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const handle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: ix,
      dispose: () => { ix.dispose(); },
    };
    const managed = new ManagedAgent(scope.agentContext, handle, []);
    registry.track(managed);
    managed.attachDurableRuntimes();
    await nextTick();

    expect(managed.runtimeSet.inspect()[0]).toMatchObject({
      id: 'failed-runtime',
      status: 'failed',
      state: { value: 0 },
      error: 'actor failed',
    });
    await managed.runtimeSet.close();
    await handle.dispose();
  });
});

describe('KeyedResourceLeasePool', () => {
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
