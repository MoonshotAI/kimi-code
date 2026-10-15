import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { registerEvent2Class } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { TodoReminderShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { TODO_LIST_TOOL_NAME, readTodoItems, todoProgress, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';
import { ToolsUpdateStore, type TodoState } from './todoOps';

import '#/agent/contextMemory/conversationTime';

registerEvent2Class(ToolsUpdateStore);

interface TodoActorContext {
  readonly todos: TodoState;
  readonly runtime: AgentActorContext<TodoState>;
}

interface TodoCommitEvent {
  readonly type: 'todo.commit';
  readonly todos: TodoState;
}

type TodoActorSnapshot = Snapshot<unknown> & { readonly context: TodoActorContext };

const todoReminder = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentActorContext<TodoState>;
  };
}) => {
  const runtime = input.runtime;
  if (runtime.agent.agentId !== MAIN_AGENT_ID) return;
  const memory = runtime.get(IAgentContextMemoryService);
  const toolPolicy = runtime.get(IAgentToolPolicyService);
  const telemetry = runtime.get(ITelemetryService);
  const bus = runtime.get(IEventBus);
  let updatedInTurn = false;
  const registration = runtime.get(IAgentReminderService).register(TODO_LIST_REMINDER_VARIANT, () => {
    const todos = runtime.getState();
    const reminder = todoListStaleReminder({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(),
      todos,
    });
    if (reminder === undefined) return undefined;
    const progress = todoProgress(todos);
    const properties: TodoReminderShownEvent = {
      turn_id: runtime.get(IAgentLoopService).snapshot().activeTurnId,
      steps_since_write: reminder.stepsSinceLastWrite,
      item_count: progress.total,
      open_count: progress.open,
    };
    telemetry.track2('todo_reminder_shown', properties);
    return reminder.text;
  });
  const change = runtime.onDidChange(() => { updatedInTurn = true; });
  const started = bus.subscribe(TurnStarted, () => { updatedInTurn = false; });
  const ended = bus.subscribe(TurnEnded, (event) => {
    const progress = todoProgress(runtime.getState());
    if (progress.total === 0 && !updatedInTurn) return;
    telemetry.track2('todo_turn_ended', {
      turn_id: event.turnId,
      reason: event.reason,
      item_count: progress.total,
      open_count: progress.open,
      updated_in_turn: updatedInTurn,
    });
  });
  return () => {
    ended.dispose();
    started.dispose();
    change.dispose();
    registration.dispose();
  };
});

const todoActorLogic = setup({
  types: {} as {
    context: TodoActorContext;
    input: AgentActorContext<TodoState>;
    events: TodoCommitEvent | AgentActorRestoreEvent;
  },
  actors: { todoReminder },
}).createMachine({
  context: ({ input }) => ({ todos: [], runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
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
    return this.actor.getState();
  }

  replace(todos: readonly TodoItem[]): Promise<void> {
    return this.actor.dispatch(new ToolsUpdateStore({
      agentId: this.actor.agent.agentId,
      key: 'todo',
      value: todos.map((todo) => ({ title: todo.title, status: todo.status })),
    }));
  }

  clear(): Promise<void> {
    return this.actor.dispatch(new ToolsUpdateStore({
      agentId: this.actor.agent.agentId,
      key: 'todo',
      value: [],
    }));
  }
}
