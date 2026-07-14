import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IInstantiationService } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { readTodoItems, type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';

interface RecordedTodoSet {
  readonly todos: readonly TodoItem[];
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly registeredTools: string[];
  readonly registeredVariants: string[];
  readonly appended: RecordedTodoSet[];
  readonly subscribed: () => number;
  readonly replay: (records: readonly PersistedRecord[]) => Promise<void>;
}

function makeFakeAgent(agentId: string): FakeAgent {
  const registeredTools: string[] = [];
  const registeredVariants: string[] = [];
  const appended: RecordedTodoSet[] = [];

  let todoState: readonly TodoItem[] = [];
  type Subscriber = (state: readonly TodoItem[], prev: readonly TodoItem[]) => void;
  const subscribers: Subscriber[] = [];
  const restoredHandlers: Array<() => void> = [];
  let subscribedCount = 0;

  const registryStub = {
    _serviceBrand: undefined,
    register: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      return toDisposable(() => {});
    },
    list: () => [],
    resolve: () => undefined,
    hooks: {},
  };

  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string) => {
      registeredVariants.push(variant);
      return toDisposable(() => {});
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => [],
  };

  const profileStub = {
    _serviceBrand: undefined,
    isToolActive: () => false,
  };

  const wireStub: IWireService = {
    _serviceBrand: undefined,
    dispatch: (...ops: unknown[]) => {
      for (const raw of ops) {
        const op = raw as { type: string; payload: unknown };
        const payload = op.payload;
        const record =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : { payload };
        appended.push({ type: op.type, ...record } as unknown as RecordedTodoSet);
        if (op.type === 'tools.update_store' && record['key'] === 'todo') {
          const prev = todoState;
          todoState = readTodoItems(record['value']);
          if (prev !== todoState) {
            for (const h of [...subscribers]) h(todoState, prev);
          }
        }
      }
    },
    replay: async (...records: PersistedRecord[]) => {
      for (const record of records) {
        if (record.type === 'tools.update_store' && record['key'] === 'todo') {
          todoState = readTodoItems(record['value']);
        }
      }
      for (const h of restoredHandlers) h();
      return { unknownRecords: 0 };
    },
    signal: () => {},
    flush: async () => {},
    attach: () => toDisposable(() => {}),
    getModel: () => todoState,
    subscribe: (_model: unknown, handler: unknown) => {
      subscribedCount += 1;
      subscribers.push(handler as Subscriber);
      return toDisposable(() => {
        const i = subscribers.indexOf(handler as Subscriber);
        if (i >= 0) subscribers.splice(i, 1);
      });
    },
    onEmission: () => toDisposable(() => {}),
    onRestored: (handler: () => void) => {
      restoredHandlers.push(handler);
      return toDisposable(() => {});
    },
  } as unknown as IWireService;

  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return registryStub as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IInstantiationService) return instantiationStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentProfileService) return profileStub as unknown as T;
      if (id === IAgentWireService) return wireStub as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };

  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor,
    dispose: () => {},
  };

  return {
    handle,
    registeredTools,
    registeredVariants,
    appended,
    subscribed: () => subscribedCount,
    replay: async (records) => {
      await wireStub.replay(...records);
    },
  };
}

interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireCreateMain: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidCreateMain = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
    onDidCreate: onDidCreate.event,
    onDidCreateMain: onDidCreateMain.event,
    onDidDispose: onDidDispose.event,
    getHandle: (id: string) => byId.get(id),
    whenReady: (id: string) => Promise.resolve(byId.get(id)),
    list: () => [...byId.values()],
    create: async () => {
      throw new Error('not implemented');
    },
    ensureMcpReady: () => Promise.resolve(),
    notifyMainCreated: () => {},
    notifyAgentTaskStopped: () => {},
    fork: async () => {
      throw new Error('not implemented');
    },
    run: () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onDidCreate.fire(h);
    },
    fireCreateMain: (h) => {
      byId.set(h.id, h);
      onDidCreateMain.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}

describe('SessionTodoService', () => {
  it('starts empty and updates the list on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    expect(service.getTodos()).toEqual([]);

    const next: TodoItem[] = [
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'in_progress' },
    ];
    service.setTodos(next);
    expect(service.getTodos()).toEqual(next);

    service.clear();
    expect(service.getTodos()).toEqual([]);
  });

  it('fires onDidChange after each setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    const seen: Array<readonly TodoItem[]> = [];
    const d = service.onDidChange((todos) => seen.push(todos));
    service.setTodos([{ title: 'x', status: 'pending' }]);
    service.setTodos([{ title: 'y', status: 'done' }]);
    d.dispose();

    expect(seen).toEqual([
      [{ title: 'x', status: 'pending' }],
      [{ title: 'y', status: 'done' }],
    ]);
  });

  it('appends a tools.update_store record to the main agent wire on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    service.setTodos([{ title: 'persist me', status: 'in_progress' }]);

    expect(main.appended).toEqual([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'persist me', status: 'in_progress' }],
      },
    ]);
  });

  it('does not append to the wire when the main agent is absent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    expect(() => service.setTodos([{ title: 'x', status: 'pending' }])).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('binds the stale-todo reminder into every created agent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    void service;

    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    lifecycle.fireCreate(main.handle);
    lifecycle.fireCreate(sub.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
  });

  it('subscribes to TodoModel only on the main agent', () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const lifecycle = makeLifecycleStub([main.handle, sub.handle]);
    const service = new SessionTodoService(lifecycle.service);
    void service;

    expect(main.subscribed()).toBe(1);
    expect(sub.subscribed()).toBe(0);
  });

  it('rebuilds the list when a todo tools.update_store record is replayed', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.replay([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'restored', status: 'done' }] },
    ]);

    expect(service.getTodos()).toEqual([{ title: 'restored', status: 'done' }]);
  });

  it('disposes per-agent bindings when the agent is disposed', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    const main = makeFakeAgent('main');
    lifecycle.fireCreate(main.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(() => lifecycle.fireDispose('main')).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('satisfies the ISessionTodoService contract', () => {
    const lifecycle = makeLifecycleStub();
    const service: ISessionTodoService = new SessionTodoService(lifecycle.service);
    expect(typeof service.getTodos).toBe('function');
    expect(typeof service.setTodos).toBe('function');
    expect(typeof service.clear).toBe('function');
    expect(typeof service.onDidChange).toBe('function');
  });

  it('cleans malformed items from a replayed todo tools.update_store record', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.replay([
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
      } as unknown as PersistedRecord,
    ]);

    expect(service.getTodos()).toEqual([{ title: 'valid', status: 'done' }]);
  });

  it('treats a non-array todo tools.update_store value as an empty list on replay', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.replay([
      { type: 'tools.update_store', key: 'todo', value: 'not-an-array' } as unknown as PersistedRecord,
    ]);

    expect(service.getTodos()).toEqual([]);
  });
});
