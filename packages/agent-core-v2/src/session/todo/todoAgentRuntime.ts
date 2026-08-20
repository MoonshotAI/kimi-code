import {
  assign,
  fromCallback,
  setup,
  type EventObject,
  type Snapshot,
} from 'xstate';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { defineAgentRuntime, IAgentRuntimeHostService } from '#/agent/runtime/agentRuntime';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentTodo } from './sessionTodo';
import { TODO_LIST_TOOL_NAME, readTodoItems, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';
import { ToolsUpdateStore, type TodoState } from './todoOps';

import '#/agent/contextMemory/conversationTime';

interface TodoActorContext {
  readonly todos: TodoState;
  readonly activation?: AgentRuntimeContext<TodoState>;
}

interface TodoCommitEvent {
  readonly type: 'todo.commit';
  readonly todos: TodoState;
}

interface TodoActivateEvent {
  readonly type: 'todo.activate';
  readonly context: AgentRuntimeContext<TodoState>;
}

type TodoActorEvent = TodoCommitEvent | TodoActivateEvent;

type TodoActorSnapshot = Snapshot<unknown> & { readonly context: TodoActorContext };

const todoReminderLogic = fromCallback<EventObject, AgentRuntimeContext<TodoState>>(
  ({ input }) => {
    const injector = input.get(IAgentContextInjectorService);
    const memory = input.get(IAgentContextMemoryService);
    const toolPolicy = input.get(IAgentToolPolicyService);
    const reminder = injector.register(TODO_LIST_REMINDER_VARIANT, () =>
      todoListStaleReminder({
        active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
        history: memory.get(),
        todos: input.getState(),
      }),
    );
    return () => { reminder.dispose(); };
  },
);

const todoActorLogic = setup({
  types: {} as {
    context: TodoActorContext;
    events: TodoActorEvent;
  },
  actors: {
    reminder: todoReminderLogic,
  },
}).createMachine({
  context: { todos: [] },
  initial: 'inactive',
  on: {
    'todo.commit': {
      actions: assign({ todos: ({ event }) => event.todos }),
    },
  },
  states: {
    inactive: {
      on: {
        'todo.activate': {
          target: 'active',
          actions: assign({ activation: ({ event }) => event.context }),
        },
      },
    },
    active: {
      invoke: {
        src: 'reminder',
        input: ({ context }) => context.activation!,
      },
    },
  },
});

export const TodoAgentRuntimeDefinition = defineAgentRuntime<TodoState, IAgentTodo>({
  id: 'todo',
  logic: todoActorLogic,
  durable: {
    events: [ToolsUpdateStore],
    undoable: true,
    transition: (_state, event) => {
      if (!(event instanceof ToolsUpdateStore) || event.key !== 'todo') return;
      return readTodoItems(event.value);
    },
    read: (snapshot) => (snapshot as TodoActorSnapshot).context.todos,
    commit: (actor, todos) => { actor.send({ type: 'todo.commit', todos }); },
  },
  createFacade: (_actor, context) => ({
    _serviceBrand: undefined,
    get: () => context.getState(),
    replace: (todos) => context.dispatch(new ToolsUpdateStore({
      agentId: context.agent.agentId,
      key: 'todo',
      value: todos.map((todo) => ({ title: todo.title, status: todo.status })),
    })),
    clear: () => context.dispatch(new ToolsUpdateStore({
      agentId: context.agent.agentId,
      key: 'todo',
      value: [],
    })),
    onDidChange: context.onDidChange,
  }),
  activate: (actor, context) => { actor.send({ type: 'todo.activate', context }); },
  inspect: (snapshot) => (snapshot as TodoActorSnapshot).context.todos.map((todo) => ({
    title: todo.title,
    status: todo.status,
  })),
});

export class AgentTodoBinding implements IAgentTodo {
  declare readonly _serviceBrand: undefined;

  private readonly todo: IAgentTodo;

  constructor(
    @IAgentRuntimeHostService host: IAgentRuntimeHostService,
    @IAgentScopeContext scope: IAgentScopeContext,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService memory: IAgentContextMemoryService,
    @IAgentToolPolicyService toolPolicy: IAgentToolPolicyService,
  ) {
    const services = new Map<ServiceIdentifier<any>, unknown>([
      [IEventDispatcher, dispatcher],
      [IAgentContextInjectorService, injector],
      [IAgentContextMemoryService, memory],
      [IAgentToolPolicyService, toolPolicy],
    ]);
    const accessor: ServicesAccessor = {
      get: <T>(id: ServiceIdentifier<T>): T => {
        if (!services.has(id)) throw new Error(`Todo runtime dependency '${String(id)}' is unavailable`);
        return services.get(id) as T;
      },
    };
    this.todo = host.resolve(scope.agentContext, TodoAgentRuntimeDefinition, accessor);
  }

  get(): readonly TodoItem[] {
    return this.todo.get();
  }

  replace(todos: readonly TodoItem[]): Promise<void> {
    return this.todo.replace(todos);
  }

  clear(): Promise<void> {
    return this.todo.clear();
  }

  get onDidChange() {
    return this.todo.onDidChange;
  }
}
