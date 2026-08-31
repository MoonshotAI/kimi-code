import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';

import { TODO_LIST_TOOL_NAME, readTodoItems, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';
import { ToolsUpdateStore, type TodoState } from './todoOps';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import '#/agent/contextMemory/conversationTime';

interface TodoActorContext {
  readonly todos: TodoState;
  readonly runtime: AgentRuntimeContext<TodoState>;
  readonly used: boolean;
}

interface TodoCommitEvent {
  readonly type: 'todo.commit';
  readonly todos: TodoState;
}

interface TodoUsedEvent {
  readonly type: 'todo.used';
}

type TodoActorSnapshot = Snapshot<unknown> & { readonly context: TodoActorContext };

const todoReminder = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentRuntimeContext<TodoState>;
  };
}) => {
  if (input.runtime.agent.agentId !== MAIN_AGENT_ID) return;
  const injector = input.runtime
    .get(IAgentLifecycleService)
    .resolve(input.runtime.agent, AgentReminder);
  const memory = input.runtime.get(IAgentContextMemoryService);
  const toolPolicy = input.runtime.get(IAgentToolPolicyService);
  const registration = injector.register(TODO_LIST_REMINDER_VARIANT, () =>
    todoListStaleReminder({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(),
      todos: input.runtime.getState(),
    }),
  );
  return () => { registration.dispose(); };
});

const todoActorLogic = setup({
  types: {} as {
    context: TodoActorContext;
    input: AgentRuntimeContext<TodoState>;
    events: TodoCommitEvent | TodoUsedEvent | AgentRuntimeRestoreEvent;
  },
  actors: { todoReminder },
}).createMachine({
  context: ({ input }) => ({ todos: [], runtime: input, used: false }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: {
        'runtime.restore': [
          { target: 'reminding', guard: ({ context }) => context.used },
          { target: 'active' },
        ],
        'todo.used': { actions: assign({ used: true }) },
      },
    },
    active: {
      on: {
        'todo.used': { target: 'reminding', actions: assign({ used: true }) },
      },
    },
    reminding: {
      invoke: {
        src: 'todoReminder',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
  on: {
    'todo.commit': {
      actions: assign({ todos: ({ event }) => event.todos }),
    },
  },
});

export class TodoRuntime {
  readonly onDidChange: AgentRuntimeContext<TodoState>['onDidChange'];

  constructor(private readonly context: AgentRuntimeContext<TodoState>) {
    this.onDidChange = context.onDidChange;
  }

  get(): readonly TodoItem[] {
    this.context.send({ type: 'todo.used' });
    return this.context.getState();
  }

  replace(todos: readonly TodoItem[]): Promise<void> {
    this.context.send({ type: 'todo.used' });
    return this.context.dispatch(new ToolsUpdateStore({
      agentId: this.context.agent.agentId,
      key: 'todo',
      value: todos.map((todo) => ({ title: todo.title, status: todo.status })),
    }));
  }

  clear(): Promise<void> {
    this.context.send({ type: 'todo.used' });
    return this.context.dispatch(new ToolsUpdateStore({
      agentId: this.context.agent.agentId,
      key: 'todo',
      value: [],
    }));
  }
}

export const AgentTodo = defineAgentRuntimeContract<TodoRuntime>('todo');

export const todoAgentRuntimeProvider = defineAgentRuntimeProvider<TodoState, TodoRuntime>(AgentTodo, {
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
  createApi: (context) => new TodoRuntime(context),
  inspect: (snapshot) => (snapshot as TodoActorSnapshot).context.todos.map((todo) => ({
    title: todo.title,
    status: todo.status,
  })),
});
