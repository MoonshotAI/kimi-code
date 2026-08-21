import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import { Emitter } from '#/_base/event';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import {
  agentContextOf,
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ContextUndone } from '#/agent/undo/undoService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { TodoAgentEffectDefinition } from '#/session/todo/todoAgentEffect';
import { TodoAgentModelDefinition } from '#/session/todo/todoAgentModel';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { AgentEffectContribution } from '#/state/agentEffect';
import { AgentModelContribution } from '#/state/agentModel';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import { stubWireJournal } from '../../wire/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

interface FakeAgent {
  readonly context: AgentContext;
  readonly handle: IAgentScopeHandle;
  readonly registeredVariants: string[];
  readonly activeReminders: () => number;
  readonly journal: WireRecord[];
  readonly dispatcher: IEventDispatcher;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
}

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function makeFakeAgent(agentId: string, generation = 1): FakeAgent {
  const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, generation });
  const context = scope.agentContext;
  const registeredVariants: string[] = [];
  const journal: WireRecord[] = [];
  const eventBus = new EventBusService();
  eventBus.activateAgent(context);
  let activeReminders = 0;
  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string) => {
      registeredVariants.push(variant);
      activeReminders += 1;
      return toDisposable(() => {
        activeReminders -= 1;
      });
    },
  };
  const memoryStub = {
    _serviceBrand: undefined,
    get: () => [],
  };
  const profileStub = {
    _serviceBrand: undefined,
    isToolActive: () => false,
  };
  const ix = new TestInstantiationService();
  ix.set(IAgentScopeContext, scope);
  ix.set(IEventBus, eventBus);
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IWireService, stubWireJournal(journal));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const dispatcher = ix.get(IEventDispatcher);
  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentScopeContext) return scope as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentProfileService) return profileStub as unknown as T;
      if (id === IAgentToolPolicyService) return profileStub as unknown as T;
      if (id === IEventBus) return eventBus as unknown as T;
      if (id === IWireService) return ix.get(IWireService) as unknown as T;
      if (id === IEventDispatcher) return dispatcher as unknown as T;
      if (id === IAgentStateService) return ix.get(IAgentStateService) as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };
  return {
    context,
    handle: {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor,
      dispose: () => {
        ix.dispose();
      },
    },
    registeredVariants,
    activeReminders: () => activeReminders,
    journal,
    dispatcher,
    restore: async (records) => {
      journal.push(...records);
      await dispatcher.restore();
    },
  };
}

interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<AgentContext>();
  const onDidCreateScope = new Emitter<{
    readonly context: AgentContext;
    readonly handle: IAgentScopeHandle;
  }>();
  const onDidDispose = new Emitter<AgentContext>();
  const byId = new Map(handles.map((handle) => [handle.id, handle]));
  return {
    service: {
      _serviceBrand: undefined,
      onDidCreate: onDidCreate.event,
      onDidCreateScope: onDidCreateScope.event,
      onDidDispose: onDidDispose.event,
      get: (context: AgentContext) => {
        const handle = byId.get(context.agentId);
        if (handle === undefined) return undefined;
        return agentContextOf(handle) === context ? handle : undefined;
      },
      findAgentHandle: (agentId: string) => byId.get(agentId),
      list: () => [...byId.values()],
      broadcastPermissionMode: () => {},
      create: async () => {
        throw new Error('not implemented');
      },
      fork: async () => {
        throw new Error('not implemented');
      },
      remove: async () => {},
    },
    fireCreate: (handle) => {
      const context = agentContextOf(handle);
      byId.set(handle.id, handle);
      onDidCreate.fire(context);
      onDidCreateScope.fire({ context, handle });
    },
    fireDispose: (agentId) => {
      const handle = byId.get(agentId);
      if (handle === undefined) return;
      const context = agentContextOf(handle);
      byId.delete(agentId);
      onDidDispose.fire(context);
    },
  };
}

interface ITodoDefinitions {}
const ITodoDefinitions = createDecorator<ITodoDefinitions>('test-todo-definitions');

class TodoDefinitions extends Service {
  constructor() {
    super();
    this.provide(AgentModelContribution, TodoAgentModelDefinition);
    this.provide(AgentEffectContribution, TodoAgentEffectDefinition);
  }
}

interface TodoRuntime {
  readonly service: ISessionTodoService;
  readonly withdrawDefinitions: () => void;
  readonly dispose: () => void;
}

function makeTodoRuntime(lifecycle: LifecycleStub): TodoRuntime {
  const context = makeSessionContext({
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: '/tmp/session-1',
    sessionScope: 'sessions/session-1',
    cwd: '/tmp',
  });
  const ix = new InstantiationService(
    new ServiceCollection(
      [IAgentLifecycleService, lifecycle.service],
      [ISessionContext, context],
    ),
    true,
  );
  const definitions = ix.provide(ITodoDefinitions, new SyncDescriptor(TodoDefinitions));
  ix.invokeFunction((accessor) => accessor.get(ITodoDefinitions));
  ix.provide(ISessionTodoService, new SyncDescriptor(SessionTodoService));
  const service = ix.invokeFunction((accessor) => accessor.get(ISessionTodoService));
  return {
    service,
    withdrawDefinitions: () => {
      definitions.dispose();
    },
    dispose: () => {
      ix.dispose();
    },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionTodoService', () => {
  it('lazily materializes Todo runtime and isolates agent state and subscriptions', async () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const lifecycle = makeLifecycleStub([main.handle, sub.handle]);
    const runtime = makeTodoRuntime(lifecycle);

    expect(main.registeredVariants).toEqual([]);
    expect(sub.registeredVariants).toEqual([]);
    await runtime.service.setTodos(main.context, [{ title: 'main todo', status: 'pending' }]);
    expect(main.registeredVariants).toEqual([TODO_LIST_REMINDER_VARIANT]);
    expect(sub.registeredVariants).toEqual([]);
    await runtime.service.setTodos(sub.context, [{ title: 'sub todo', status: 'done' }]);

    expect(await runtime.service.getTodos(main.context)).toEqual([
      { title: 'main todo', status: 'pending' },
    ]);
    expect(await runtime.service.getTodos(sub.context)).toEqual([
      { title: 'sub todo', status: 'done' },
    ]);
    expect(main.activeReminders()).toBe(1);
    expect(sub.activeReminders()).toBe(0);
    runtime.dispose();
  });

  it('accepts only the current lifecycle-issued context object', async () => {
    const main = makeFakeAgent('main', 4);
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle]));
    const forged = {
      agentId: main.context.agentId,
      generation: main.context.generation,
    } as AgentContext;
    const unknown = stubAgentContext('unknown');

    expect(await runtime.service.getTodos(main.context)).toEqual([]);
    await expect(runtime.service.getTodos(forged)).rejects.toThrow(
      'is not a lifecycle-issued context',
    );
    await expect(runtime.service.getTodos(unknown)).rejects.toThrow(
      'Agent unknown:1 is stale',
    );
    runtime.dispose();
  });

  it('fires agent-partitioned changes after writes', async () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle, sub.handle]));
    const seen: Array<{ agent: AgentContext; todos: readonly TodoItem[] }> = [];
    const subscription = runtime.service.onDidChange((change) => seen.push(change));

    await runtime.service.setTodos(main.context, [{ title: 'a', status: 'pending' }]);
    await runtime.service.setTodos(sub.context, [{ title: 'b', status: 'done' }]);
    subscription.dispose();

    expect(seen).toEqual([
      { agent: main.context, todos: [{ title: 'a', status: 'pending' }] },
      { agent: sub.context, todos: [{ title: 'b', status: 'done' }] },
    ]);
    runtime.dispose();
  });

  it('fires the restored list once when undo changes one agent state', async () => {
    const main = makeFakeAgent('main');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle]));
    await runtime.service.setTodos(main.context, [{ title: 'doomed', status: 'in_progress' }]);
    const seen: TodoItem[][] = [];
    const subscription = runtime.service.onDidChange((change) => seen.push([...change.todos]));

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'kept', status: 'pending' }] },
    ]);
    await main.dispatcher.dispatch(new ContextUndone({ agentId: 'main', turns: 1 }));
    await main.dispatcher.dispatch(new ContextUndone({ agentId: 'main', turns: 1 }));
    subscription.dispose();

    expect(seen).toEqual([[{ title: 'kept', status: 'pending' }]]);
    runtime.dispose();
  });

  it('appends writes to the selected agent wire and replays them', async () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle, sub.handle]));

    await runtime.service.setTodos(sub.context, [{ title: 'persist me', status: 'in_progress' }]);
    expect(main.journal).toEqual([]);
    expect(sub.journal).toEqual([
      {
        type: 'tools.update_store',
        agentId: 'agent-1',
        key: 'todo',
        value: [{ title: 'persist me', status: 'in_progress' }],
        time: expect.any(Number),
      },
    ]);

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'restored', status: 'done' }] },
    ]);
    expect(await runtime.service.getTodos(main.context)).toEqual([
      { title: 'restored', status: 'done' },
    ]);
    runtime.dispose();
  });

  it('binds the stale-todo reminder only into the main agent', async () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle, sub.handle]));

    await runtime.service.getTodos(main.context);
    await runtime.service.getTodos(sub.context);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).not.toContain(TODO_LIST_REMINDER_VARIANT);
    runtime.dispose();
  });

  it('cleans malformed replay values', async () => {
    const main = makeFakeAgent('main');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle]));
    await main.restore([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
          { title: 'bad status', status: 'wip' },
        ],
      } as unknown as WireRecord,
    ]);

    expect(await runtime.service.getTodos(main.context)).toEqual([{ title: 'valid', status: 'done' }]);
    runtime.dispose();
  });

  it('releases only the disposed agent runtime', async () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const lifecycle = makeLifecycleStub([main.handle, sub.handle]);
    const runtime = makeTodoRuntime(lifecycle);
    await runtime.service.getTodos(main.context);
    await runtime.service.getTodos(sub.context);

    lifecycle.fireDispose('main');
    await nextTick();

    expect(main.activeReminders()).toBe(0);
    expect(sub.activeReminders()).toBe(0);
    await expect(runtime.service.getTodos(main.context)).rejects.toThrow('Agent main:1 is stale');
    runtime.dispose();
  });

  it('isolates a recreated agent with the same id from the stale context', async () => {
    const first = makeFakeAgent('main', 1);
    const lifecycle = makeLifecycleStub([first.handle]);
    const runtime = makeTodoRuntime(lifecycle);
    await runtime.service.setTodos(first.context, [{ title: 'old', status: 'pending' }]);

    lifecycle.fireDispose('main');
    const second = makeFakeAgent('main', 2);
    lifecycle.fireCreate(second.handle);
    await nextTick();

    await expect(runtime.service.getTodos(first.context)).rejects.toThrow(
      'Agent main:1 is stale',
    );
    expect(await runtime.service.getTodos(second.context)).toEqual([]);
    await runtime.service.setTodos(second.context, [{ title: 'new', status: 'done' }]);
    expect(await runtime.service.getTodos(second.context)).toEqual([
      { title: 'new', status: 'done' },
    ]);
    runtime.dispose();
  });

  it('withdraws Todo definitions and disposes materialized subscriptions', async () => {
    const main = makeFakeAgent('main');
    const runtime = makeTodoRuntime(makeLifecycleStub([main.handle]));
    await runtime.service.getTodos(main.context);
    expect(main.activeReminders()).toBe(1);

    runtime.withdrawDefinitions();
    await nextTick();

    expect(main.activeReminders()).toBe(0);
    await expect(runtime.service.getTodos(main.context)).rejects.toThrow(
      'resource definition is unavailable',
    );
    runtime.dispose();
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

  it('aborts an explicitly abortable resource during agent shutdown', async () => {
    const events: string[] = [];
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 3 },
      () => ({
        abort: () => {
          events.push('abort');
        },
        dispose: () => {
          events.push('dispose');
        },
      }),
    );
    const lease = await pool.acquire('main');
    const disposal = pool.disposeKey('main', 'agent-disposed', true);

    await nextTick();
    expect(events).toEqual(['abort']);
    lease.release();
    await disposal;
    expect(events).toEqual(['abort', 'dispose']);
  });

  it('lets an explicitly abortable resource finish its lease on definition withdraw', async () => {
    const events: string[] = [];
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 3 },
      () => ({
        abort: () => {
          events.push('abort');
        },
        dispose: () => {
          events.push('dispose');
        },
      }),
    );
    const lease = await pool.acquire('main');
    const withdrawal = pool.withdraw();

    await nextTick();
    expect(events).toEqual([]);
    lease.release();
    await withdrawal;
    expect(events).toEqual(['dispose']);
  });
});
