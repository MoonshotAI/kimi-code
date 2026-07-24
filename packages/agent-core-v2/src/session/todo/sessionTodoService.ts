/**
 * `todo` domain (L4) — `ISessionTodoService` implementation.
 *
 * Provides session-wide todo access through the main agent's `wire`, binds
 * todo capabilities into each agent, and publishes changes through its typed
 * event. The main agent's wire owns the replayable state (including the
 * undo-checkpointed `TodoModel`); this facade keeps no list copy of its own
 * and there is deliberately no second session-level wire aggregate. Bound at
 * Session scope.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IWireService } from '#/wire/wire';

import { ISessionTodoService } from './sessionTodo';
import { TodoModel, todoSet } from './todoOps';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';

const MAIN_AGENT_ID = 'main';

export class SessionTodoService extends Disposable implements ISessionTodoService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<readonly TodoItem[]>());
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly agentBindings = new Map<string, IDisposable[]>();
  private lastKnownTodos: readonly TodoItem[] = [];

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();

    this._register(
      this.agentLifecycle.onDidCreate((handle) => {
        this.bindAgent(handle);
      }),
    );
    this._register(
      this.agentLifecycle.onDidDispose((agentId) => this.disposeAgentBindings(agentId)),
    );

    for (const handle of this.agentLifecycle.list()) {
      this.bindAgent(handle);
    }

    this._register(
      toDisposable(() => {
        for (const agentId of Array.from(this.agentBindings.keys())) {
          this.disposeAgentBindings(agentId);
        }
      }),
    );
  }

  getTodos(): readonly TodoItem[] {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return [];
    return main.accessor.get(IWireService).getModel(TodoModel).current;
  }

  setTodos(todos: readonly TodoItem[]): void {
    const next: readonly TodoItem[] = todos.map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
    this.dispatchTodoSet(next);
  }

  clear(): void {
    this.setTodos([]);
  }

  private dispatchTodoSet(todos: readonly TodoItem[]): void {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return;
    const wire = main.accessor.get(IWireService);
    wire.dispatch(todoSet({ key: 'todo', value: todos }));
    const current = wire.getModel(TodoModel).current;
    this.lastKnownTodos = current;
    this.onDidChangeEmitter.fire(current);
  }

  private bindAgent(handle: IAgentScopeHandle): void {
    const injector = handle.accessor.get(IAgentContextInjectorService);
    this.trackAgentBinding(
      handle.id,
      injector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder(handle)),
    );
    if (handle.id !== MAIN_AGENT_ID) return;

    this.lastKnownTodos = handle.accessor.get(IWireService).getModel(TodoModel).current;
    this.trackAgentBinding(
      handle.id,
      handle.accessor.get(IEventBus).subscribe('context.undone', () => {
        const current = handle.accessor.get(IWireService).getModel(TodoModel).current;
        if (todoItemsEqual(current, this.lastKnownTodos)) return;
        this.lastKnownTodos = current;
        this.onDidChangeEmitter.fire(current);
      }),
    );
  }

  private staleReminder(handle: IAgentScopeHandle): string | undefined {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const toolPolicy = handle.accessor.get(IAgentToolPolicyService);
    return todoListStaleReminder({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(),
      todos: this.getTodos(),
    });
  }

  private trackAgentBinding(agentId: string, disposable: IDisposable): void {
    const list = this.agentBindings.get(agentId);
    if (list === undefined) {
      this.agentBindings.set(agentId, [disposable]);
    } else {
      list.push(disposable);
    }
  }

  private disposeAgentBindings(agentId: string): void {
    const bindings = this.agentBindings.get(agentId);
    if (bindings === undefined) return;
    for (const disposable of bindings) {
      disposable.dispose();
    }
    this.agentBindings.delete(agentId);
    if (agentId === MAIN_AGENT_ID) this.lastKnownTodos = [];
  }
}

function todoItemsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => item.title === b[index]?.title && item.status === b[index]?.status)
  );
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTodoService,
  SessionTodoService,
  InstantiationType.Eager,
  'todo',
);
