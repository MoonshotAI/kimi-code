import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { registerEvent2Class } from '#/app/event/event2';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { TODO_LIST_TOOL_NAME, readTodoItems, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';
import { ToolsUpdateStore, type TodoState } from './todoOps';

import '#/agent/contextMemory/conversationTime';

registerEvent2Class(ToolsUpdateStore);

interface TodoActorContext {
  readonly todos: TodoState;
  readonly runtime: AgentActorContext<TodoState>;
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
    readonly runtime: AgentActorContext<TodoState>;
  };
}) => {
  if (input.runtime.agent.agentId !== MAIN_AGENT_ID) return;
  const injector = input.runtime.get(IAgentReminderService);
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
    input: AgentActorContext<TodoState>;
    events: TodoCommitEvent | TodoUsedEvent | AgentActorRestoreEvent;
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

export interface IAgentTodoService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<TodoState>;
  get(): readonly TodoItem[];
  replace(todos: readonly TodoItem[]): Promise<void>;
  clear(): Promise<void>;
}

export const IAgentTodoService = createDecorator<IAgentTodoService>('agentTodoService');

export class AgentTodoService extends AgentActorService<TodoState> implements IAgentTodoService {
  declare readonly _serviceBrand: undefined;
  readonly onDidChange: IAgentTodoService['onDidChange'];

  private readonly actor: AgentActorContext<TodoState>;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.actor = this.attachActor(todoActorLogic, {
      id: 'todo',
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
    });
    this.onDidChange = this.actor.onDidChange;
  }

  get(): readonly TodoItem[] {
    this.actor.send({ type: 'todo.used' });
    return this.actor.getState();
  }

  replace(todos: readonly TodoItem[]): Promise<void> {
    this.actor.send({ type: 'todo.used' });
    return this.actor.dispatch(new ToolsUpdateStore({
      agentId: this.actor.agent.agentId,
      key: 'todo',
      value: todos.map((todo) => ({ title: todo.title, status: todo.status })),
    }));
  }

  clear(): Promise<void> {
    this.actor.send({ type: 'todo.used' });
    return this.actor.dispatch(new ToolsUpdateStore({
      agentId: this.actor.agent.agentId,
      key: 'todo',
      value: [],
    }));
  }
}
