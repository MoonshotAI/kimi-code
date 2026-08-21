import { assign, setup, type Snapshot } from 'xstate';

import {
  defineAgentRuntime,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';

import { TODO_LIST_TOOL_NAME, readTodoItems, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';
import { ToolsUpdateStore, type TodoState } from './todoOps';

import '#/agent/contextMemory/conversationTime';

interface TodoActorContext {
  readonly todos: TodoState;
}

interface TodoCommitEvent {
  readonly type: 'todo.commit';
  readonly todos: TodoState;
}

type TodoActorSnapshot = Snapshot<unknown> & { readonly context: TodoActorContext };

const todoActorLogic = setup({
  types: {} as {
    context: TodoActorContext;
    events: TodoCommitEvent;
  },
}).createMachine({
  context: { todos: [] },
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
    const injector = context.get(IAgentContextInjectorService);
    const memory = context.get(IAgentContextMemoryService);
    const toolPolicy = context.get(IAgentToolPolicyService);
    context.own(injector.register(TODO_LIST_REMINDER_VARIANT, () =>
      todoListStaleReminder({
        active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
        history: memory.get(),
        todos: context.getState(),
      }),
    ));
  }

  get(): readonly TodoItem[] {
    return this.context.getState();
  }

  replace(todos: readonly TodoItem[]): Promise<void> {
    return this.context.dispatch(new ToolsUpdateStore({
      agentId: this.context.agent.agentId,
      key: 'todo',
      value: todos.map((todo) => ({ title: todo.title, status: todo.status })),
    }));
  }

  clear(): Promise<void> {
    return this.context.dispatch(new ToolsUpdateStore({
      agentId: this.context.agent.agentId,
      key: 'todo',
      value: [],
    }));
  }
}

export const AgentTodo = defineAgentRuntime<TodoState, TodoRuntime>({
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
  create: (context) => new TodoRuntime(context),
  inspect: (snapshot) => (snapshot as TodoActorSnapshot).context.todos.map((todo) => ({
    title: todo.title,
    status: todo.status,
  })),
});
