import { describe, expect, it } from 'vitest';
import { fromCallback } from 'xstate';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { deactivateAgentContext } from '#/agent/agentContext/agentContextIdentity';
import {
  AgentRuntimeHost,
  defineAgentRuntime,
  IAgentRuntimeHostService,
} from '#/agent/runtime/agentRuntime';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ContextAppendMessage, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentTodo } from '#/session/todo/sessionTodo';
import {
  AgentTodoBinding,
  TodoAgentRuntimeDefinition,
} from '#/session/todo/todoAgentRuntime';
import type { TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
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
  readonly todo: IAgentTodo;
  readonly dispatcher: IEventDispatcher;
  readonly journal: WireRecord[];
  readonly registeredVariants: string[];
  readonly activeReminders: () => number;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
  readonly dispose: () => void;
}

function runtimeHostService(host: AgentRuntimeHost): IAgentRuntimeHostService {
  return {
    _serviceBrand: undefined,
    resolve: (agent, definition) => host.resolve(agent, definition),
    participants: (agent) => host.participants(agent),
    snapshot: (agent) => host.snapshot(agent),
    inspect: (agent) => host.snapshot(agent),
    disposeAgent: (agent) => { host.disposeAgent(agent); },
  };
}

function makeRuntimeAgent(
  host: AgentRuntimeHost,
  service: IAgentRuntimeHostService,
  accessors: Map<AgentContext, ServicesAccessor>,
  agentId: string,
  generation = 1,
  beforeResolve?: (state: {
    readonly context: AgentContext;
    readonly activeReminders: () => number;
  }) => void,
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
  ix.set(IAgentRuntimeHostService, service);
  ix.set(IAgentContextInjectorService, {
    _serviceBrand: undefined,
    register: (variant: string) => {
      registeredVariants.push(variant);
      reminders += 1;
      return toDisposable(() => { reminders -= 1; });
    },
  } as unknown as IAgentContextInjectorService);
  ix.set(IAgentContextMemoryService, {
    _serviceBrand: undefined,
    get: () => [],
  } as unknown as IAgentContextMemoryService);
  ix.set(IAgentToolPolicyService, {
    _serviceBrand: undefined,
    isToolActive: () => false,
  } as unknown as IAgentToolPolicyService);
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const dispatcher = ix.get(IEventDispatcher);
  const accessor: ServicesAccessor = { get: (id) => ix.get(id) };
  accessors.set(context, accessor);
  beforeResolve?.({ context, activeReminders: () => reminders });
  const todo = host.resolve(context, TodoAgentRuntimeDefinition);
  return {
    context,
    todo,
    dispatcher,
    journal,
    registeredVariants,
    activeReminders: () => reminders,
    restore: async (records) => {
      journal.push(...records);
      await dispatcher.restore();
    },
    dispose: () => {
      accessors.delete(context);
      deactivateAgentContext(context);
      ix.dispose();
    },
  };
}

function makeHost() {
  const accessors = new Map<AgentContext, ServicesAccessor>();
  const host = new AgentRuntimeHost((agent) => accessors.get(agent));
  const registration = host.register(TodoAgentRuntimeDefinition);
  const service = runtimeHostService(host);
  return { host, registration, service, accessors };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TodoAgentRuntime', () => {
  it('isolates state by agent and generation', async () => {
    const runtime = makeHost();
    const main = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main', 1);
    const sub = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'agent-1', 1);
    const next = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main', 2);

    await main.todo.replace([{ title: 'main todo', status: 'pending' }]);
    await sub.todo.replace([{ title: 'sub todo', status: 'done' }]);

    expect(main.todo.get()).toEqual([{ title: 'main todo', status: 'pending' }]);
    expect(sub.todo.get()).toEqual([{ title: 'sub todo', status: 'done' }]);
    expect(next.todo.get()).toEqual([]);
    expect(main.registeredVariants).toEqual([TODO_LIST_REMINDER_VARIANT]);
    expect(sub.activeReminders()).toBe(1);
    runtime.host.dispose();
    main.dispose();
    sub.dispose();
    next.dispose();
  });

  it('materializes durable state before facade activation and starts the reminder once', () => {
    const runtime = makeHost();
    const agent = makeRuntimeAgent(
      runtime.host,
      runtime.service,
      runtime.accessors,
      'main',
      1,
      ({ context, activeReminders }) => {
        expect(activeReminders()).toBe(0);
        expect(runtime.host.snapshot(context).contributions[0]).toMatchObject({
          status: 'materialized',
          state: [],
        });
      },
    );

    expect(agent.activeReminders()).toBe(1);
    expect(runtime.host.resolve(agent.context, TodoAgentRuntimeDefinition)).toBe(agent.todo);
    expect(agent.activeReminders()).toBe(1);
    runtime.host.dispose();
    agent.dispose();
  });

  it('rejects a forged context even when the matching runtime facade already exists', () => {
    const runtime = makeHost();
    const agent = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main', 7);
    const forged = {
      agentId: agent.context.agentId,
      generation: agent.context.generation,
      space: agent.context.space,
    } as AgentContext;

    expect(() => runtime.host.resolve(forged, TodoAgentRuntimeDefinition)).toThrow(
      'is not a lifecycle-issued context',
    );
    expect(() => runtime.host.participants(forged)).toThrow(
      'is not a lifecycle-issued context',
    );
    runtime.host.dispose();
    agent.dispose();
  });

  it('resolves the Agent DI facade once and reuses the stable binding', () => {
    const runtime = makeHost();
    const agent = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main');
    let resolves = 0;
    const countingHost: IAgentRuntimeHostService = {
      ...runtime.service,
      resolve: (context, definition, accessor) => {
        resolves += 1;
        return runtime.service.resolve(context, definition, accessor);
      },
    };
    const binding = new AgentTodoBinding(
      countingHost,
      {
        _serviceBrand: undefined,
        agentId: agent.context.agentId,
        agentContext: agent.context,
        scope: () => 'agents/main',
      },
      agent.dispatcher,
      {} as IAgentContextInjectorService,
      {} as IAgentContextMemoryService,
      {} as IAgentToolPolicyService,
    );

    expect(binding.get()).toEqual([]);
    binding.onDidChange(() => {}).dispose();
    expect(resolves).toBe(1);
    runtime.host.dispose();
    agent.dispose();
  });

  it('appends the existing tools.update_store wire and restores malformed values safely', async () => {
    const runtime = makeHost();
    const agent = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main');
    await agent.todo.replace([{ title: 'persist me', status: 'in_progress' }]);

    expect(agent.journal).toEqual([{
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [{ title: 'persist me', status: 'in_progress' }],
      time: expect.any(Number),
    }]);

    const restoredRuntime = makeHost();
    const restored = makeRuntimeAgent(
      restoredRuntime.host,
      restoredRuntime.service,
      restoredRuntime.accessors,
      'main',
    );
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
    runtime.host.dispose();
    restoredRuntime.host.dispose();
    agent.dispose();
    restored.dispose();
  });

  it('restores conversation undo and emits each actual change once', async () => {
    const runtime = makeHost();
    const agent = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main');
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
    runtime.host.dispose();
    agent.dispose();
  });

  it('releases concrete actors on agent dispose and definition withdraw', async () => {
    const runtime = makeHost();
    const main = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'main');
    const sub = makeRuntimeAgent(runtime.host, runtime.service, runtime.accessors, 'agent-1');
    expect(main.activeReminders()).toBe(1);
    expect(sub.activeReminders()).toBe(1);

    runtime.host.disposeAgent(main.context);
    expect(main.activeReminders()).toBe(0);
    expect(sub.activeReminders()).toBe(1);
    expect(() => runtime.host.resolve(main.context, TodoAgentRuntimeDefinition)).not.toThrow();

    runtime.registration.withdraw();
    expect(main.activeReminders()).toBe(0);
    expect(sub.activeReminders()).toBe(0);
    expect(() => runtime.host.resolve(sub.context, TodoAgentRuntimeDefinition)).toThrow('unavailable');
    runtime.host.dispose();
    main.dispose();
    sub.dispose();
  });

  it('reports registered, materialized, retired, and definition generations', () => {
    const accessors = new Map<AgentContext, ServicesAccessor>();
    const host = new AgentRuntimeHost((agent) => accessors.get(agent));
    const first = host.register(TodoAgentRuntimeDefinition);
    const agent = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }).agentContext;

    expect(host.snapshot(agent).contributions[0]).toMatchObject({
      id: 'todo',
      generation: 1,
      status: 'registered',
    });
    host.participants(agent);
    expect(host.snapshot(agent).contributions[0]).toMatchObject({ status: 'materialized', state: [] });
    first.withdraw();
    expect(host.snapshot(agent).contributions[0]).toMatchObject({ status: 'retired' });
    const second = host.register(TodoAgentRuntimeDefinition);
    expect(host.snapshot(agent).contributions[0]).toMatchObject({ generation: 2, status: 'registered' });
    second.withdraw();
    host.dispose();
    deactivateAgentContext(agent);
  });

  it('retains actor failure status and inspection diagnostics', async () => {
    const host = new AgentRuntimeHost();
    const definition = defineAgentRuntime<number, object>({
      id: 'failed-runtime',
      logic: fromCallback(() => { throw new Error('actor failed'); }),
      durable: {
        events: [],
        undoable: false,
        transition: () => {},
        read: () => 0,
        commit: () => {},
      },
      createFacade: () => ({}),
      inspect: () => ({ value: 0 }),
    });
    host.register(definition);
    const agent = makeAgentScopeContext({
      agentId: 'main',
      agentScope: 'agents/main',
    }).agentContext;

    host.participants(agent);
    await nextTick();

    expect(host.snapshot(agent).contributions[0]).toMatchObject({
      id: 'failed-runtime',
      status: 'failed',
      state: { value: 0 },
      error: 'actor failed',
    });
    host.dispose();
    deactivateAgentContext(agent);
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
